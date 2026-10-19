import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env, isTest } from '../../config/env';
import { asyncHandler } from '../../utils/http';
import { loggerFor } from '../../observability/logger';
import * as router from '../../services/platform/router.service';
import * as webhooks from '../../services/platform/webhooks.service';
import { handleInbound } from '../whatsapp/whatsapp.service';
import { queryOne } from '../../db/pool';

const log = loggerFor('platform-webhook');

export const platformWebhookRouter = Router();

/**
 * The single inbound endpoint for every tenant on the platform.
 *
 * Meta delivers all of an app's traffic to one URL no matter how many customer
 * accounts are subscribed to it, so this route is shared by every business we
 * onboard. The tenant is derived from the number the message arrived on.
 *
 * Three properties matter here and are easy to get wrong:
 *
 *   - It always answers 200 once the signature is valid. Meta retries any
 *     other status with increasing delays, and a bug in one tenant's handling
 *     must not cause redelivery storms for all of them.
 *   - Work happens after the signature check and never before it.
 *   - A number we do not serve is answered normally, not with an error: it is
 *     a routine consequence of a disconnect, not a fault.
 */

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Generous: this is every tenant's traffic through one door.
  limit: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * GET — Meta's subscription handshake.
 *
 * Called once when the callback URL is saved in the app dashboard. It must
 * echo hub.challenge verbatim, as plain text, or the URL cannot be saved.
 */
platformWebhookRouter.get('/meta', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && env.whatsappVerifyToken && token === env.whatsappVerifyToken) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }

  log.warn('webhook verification rejected');
  res.status(403).send('Verification failed.');
});

platformWebhookRouter.post(
  '/meta',
  webhookLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!router.verifyMetaSignature(rawBody, signature)) {
      // 403 rather than 200: an unsigned request is not a delivery to retry,
      // and answering 200 would tell a prober that the URL is live and happy.
      log.warn({ hasSignature: Boolean(signature) }, 'rejected unsigned webhook');
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Invalid signature.' } });
      return;
    }

    let processed = 0;
    let failed = 0;

    try {
      const outcome = await router.route(req.body);

      for (const message of outcome.messages) {
        try {
          await handleRoutedMessage(message);
          processed += 1;
        } catch (error) {
          // One tenant's failure must not abandon the rest of the batch.
          failed += 1;
          log.error(
            { tenantId: message.route.tenantId, err: (error as Error).message },
            'inbound handling failed'
          );
        }
      }

      for (const status of outcome.statuses) {
        try {
          await router.applyStatus(status);
        } catch (error) {
          log.error({ err: (error as Error).message }, 'status update failed');
        }
      }

      if (outcome.unroutable > 0) {
        log.info({ count: outcome.unroutable }, 'deliveries for numbers not served here');
      }
    } catch (error) {
      // Logged, not rethrown: see the always-200 rule above.
      log.error({ err: (error as Error).message }, 'webhook processing failed');
    }

    res.status(200).json({ success: true, data: { processed, failed } });
  })
);

/**
 * Applies one routed message: contact book, metering, the tenant's own
 * webhook, and the helpdesk app if that tenant uses it.
 *
 * The order is deliberate. The tenant's webhook fires whether or not the
 * helpdesk is enabled, because a tenant using us purely as an API still needs
 * the message; the helpdesk runs last because it is just one consumer.
 */
async function handleRoutedMessage(message: router.RoutedMessage): Promise<void> {
  const { route: target } = message;

  await router.touchContact(target.tenantId, message.from, message.profileName);
  await router.recordUsage(target.tenantId, 'message.received', target.numberId);

  await webhooks.emit(target.tenantId, 'message.received', {
    message_id: message.providerMessageId,
    from: message.from,
    to: message.displayPhoneNumber,
    phone_number_id: target.phoneNumberId,
    text: message.body,
    profile_name: message.profileName,
  });

  if (!target.helpdeskEnabled) {
    // Still recorded, so the tenant's console shows the conversation even
    // when the built-in app is not the thing answering it.
    await recordInboundOnly(message);
    return;
  }

  const slug = await tenantSlug(target.tenantId);

  const outcome = await handleInbound(
    {
      providerMessageId: message.providerMessageId,
      from: message.from,
      body: message.body,
    },
    'meta',
    { tenantId: target.tenantId, slug, numberId: target.numberId }
  );

  if (!outcome.handled) {
    log.info({ tenantId: target.tenantId, reason: outcome.reason }, 'message not handled');
  }
}

/** Logs the message for a tenant whose helpdesk app is switched off. */
async function recordInboundOnly(message: router.RoutedMessage): Promise<void> {
  const { route: target } = message;

  await queryOne(
    `INSERT INTO whatsapp_messages
       (tenant_id, number_id, direction, provider_message_id, wa_number, body, status, provider)
     VALUES ($1, $2, 'INBOUND', $3, $4, $5, 'DELIVERED', 'meta')
     ON CONFLICT (tenant_id, provider_message_id) DO NOTHING
     RETURNING id`,
    [target.tenantId, target.numberId, message.providerMessageId, message.from, message.body]
  );
}

const slugCache = new Map<string, string>();

async function tenantSlug(tenantId: string): Promise<string> {
  const cached = slugCache.get(tenantId);
  if (cached) return cached;

  const row = await queryOne<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [tenantId]);
  const slug = row?.slug ?? 'unknown';
  slugCache.set(tenantId, slug);
  return slug;
}
