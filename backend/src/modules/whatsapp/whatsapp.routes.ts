import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, paginationMeta } from '../../utils/http';
import { ApiError } from '../../utils/ApiError';
import { recordAudit } from '../../services/audit';
import {
  parseWebhook,
  sendMessage,
  verifySignature,
  whatsappStatus,
  normaliseNumber,
} from '../../services/whatsapp';
import { handleInbound } from './whatsapp.service';
import { isTest } from '../../config/env';
import { loggerFor } from '../../observability/logger';

const log = loggerFor('whatsapp');

export const whatsappRouter = Router();

/**
 * The webhook is a public endpoint — the provider calls it, not a signed-in
 * user — so it is rate limited and signature-verified rather than authenticated.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * POST /api/whatsapp/webhook
 *
 * Always returns 200, even on failure. Providers retry any non-2xx response,
 * and a message we cannot process will fail identically on every retry — so
 * returning an error would produce an unbounded retry loop rather than fixing
 * anything. Problems are recorded server-side instead.
 */
whatsappRouter.post(
  '/webhook',
  webhookLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const headers = req.headers as Record<string, string | undefined>;
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

    if (!verifySignature(rawBody, headers)) {
      // 403 here is deliberate: an unsigned request is not a delivery to retry.
      throw ApiError.forbidden('Invalid webhook signature.');
    }

    let processed = 0;
    try {
      const messages = parseWebhook(req.body);
      for (const message of messages) {
        const outcome = await handleInbound(message, whatsappStatus.active);
        if (outcome.handled) processed += 1;
        else log.warn({ reason: outcome.reason }, 'inbound WhatsApp message not handled');
      }
    } catch (error) {
      log.error({ err: (error as Error).message }, 'webhook processing failed');
    }

    res.status(200).json({ success: true, data: { processed } });
  })
);

/**
 * GET /api/whatsapp/webhook
 * Meta's Cloud API verifies a webhook by echoing a challenge. Harmless for
 * Twilio, and means switching providers needs no route change.
 */
whatsappRouter.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.status(403).send('Verification failed.');
});

// --- admin console ---------------------------------------------------------

whatsappRouter.use('/admin', requireAuth, requireRole('ADMIN'));

/** GET /api/whatsapp/admin/status — which provider is live. */
whatsappRouter.get(
  '/admin/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = await queryOne<{
      inbound: string;
      outbound: string;
      failed: string;
      tickets: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM whatsapp_messages WHERE direction = 'INBOUND')  AS inbound,
         (SELECT COUNT(*)::TEXT FROM whatsapp_messages WHERE direction = 'OUTBOUND') AS outbound,
         (SELECT COUNT(*)::TEXT FROM whatsapp_messages WHERE status = 'FAILED')      AS failed,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE channel = 'WHATSAPP')             AS tickets`
    );

    ok(res, {
      configuredProvider: whatsappStatus.configured,
      activeProvider: whatsappStatus.active,
      simulated: whatsappStatus.simulated,
      fromNumber: whatsappStatus.fromNumber,
      inboundMessages: Number(stats?.inbound ?? 0),
      outboundMessages: Number(stats?.outbound ?? 0),
      failedMessages: Number(stats?.failed ?? 0),
      ticketsFromWhatsApp: Number(stats?.tickets ?? 0),
    });
  })
);

/** GET /api/whatsapp/admin/messages — the message log. */
whatsappRouter.get(
  '/admin/messages',
  validate(
    z.object({
      direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    'query'
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { direction, page, limit } = req.query as never as {
      direction?: string;
      page: number;
      limit: number;
    };

    const params: unknown[] = [];
    let where = '';
    if (direction) {
      params.push(direction);
      where = `WHERE w.direction = $${params.length}`;
    }

    const totals = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM whatsapp_messages w ${where}`,
      params
    );

    const rows = await query<{
      id: string;
      direction: string;
      wa_number: string;
      body: string;
      status: string;
      error_detail: string | null;
      created_at: Date;
      reference: string | null;
    }>(
      `SELECT w.id, w.direction::TEXT, w.wa_number, w.body, w.status::TEXT,
              w.error_detail, w.created_at, t.reference
         FROM whatsapp_messages w
         LEFT JOIN tickets t ON t.id = w.ticket_id
         ${where}
        ORDER BY w.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    ok(
      res,
      rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        // Only the last four digits are shown; the console does not need to
        // display full customer phone numbers to be useful.
        number: `••••${r.wa_number.slice(-4)}`,
        body: r.body,
        status: r.status,
        error: r.error_detail,
        ticketReference: r.reference,
        createdAt: r.created_at,
      })),
      paginationMeta(page, limit, Number(totals[0]?.count ?? 0))
    );
  })
);

/**
 * POST /api/whatsapp/admin/simulate — inject an inbound message.
 *
 * This is how the channel is demonstrated without a phone: an admin posts a
 * message as if it had arrived from a number, and the full inbound path runs.
 */
whatsappRouter.post(
  '/admin/simulate',
  validate(
    z.object({
      from: z.string().trim().min(8, 'Enter a phone number in international format.'),
      body: z.string().trim().min(1, 'Enter a message.').max(4000),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { from, body } = req.body;
    const number = normaliseNumber(from);
    if (!number) throw ApiError.badRequest('That is not a valid phone number. Use +91XXXXXXXXXX.');

    const outcome = await handleInbound(
      {
        providerMessageId: `admin-sim-${Date.now()}-${Math.round(process.hrtime()[1] / 1000)}`,
        from: number,
        body,
      },
      whatsappStatus.active
    );

    await recordAudit(req, 'WHATSAPP_SIMULATED', 'whatsapp', null, { from: number });
    ok(res, outcome);
  })
);

/** POST /api/whatsapp/admin/test-send — verify outbound delivery works. */
whatsappRouter.post(
  '/admin/test-send',
  validate(
    z.object({
      to: z.string().trim().min(8),
      body: z.string().trim().min(1).max(1000),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { to, body } = req.body;
    const result = await sendMessage(to, body, { userId: req.user!.id });
    await recordAudit(req, 'WHATSAPP_TEST_SEND', 'whatsapp', null, { delivered: result.delivered });
    ok(res, result);
  })
);
