import { query, queryOne } from '../../db/pool';
import { loggerFor } from '../../observability/logger';
import { sendMessage as sendViaFirstPartyProvider, normaliseNumber } from '../whatsapp';
import * as graph from './graph.client';
import { sendingIdentity } from './onboarding.service';
import { describeFailure } from './onboarding.service';
import { recordUsage } from './router.service';
import * as webhooks from './webhooks.service';

const log = loggerFor('messaging');

/**
 * Outbound messaging for a tenant.
 *
 * Which credentials are used depends on how the tenant got their number:
 *
 *   - Onboarded through Embedded Signup — their own WABA and their own access
 *     token, decrypted per send. This is every tenant on the platform.
 *   - The first-party number configured in this deployment's environment —
 *     used by the original single-tenant deployment, which became tenant one
 *     when the platform was introduced. Kept so that deployment did not break.
 *
 * Callers never choose; they ask to send as a tenant and this decides.
 */

export interface SendOptions {
  numberId?: string | null;
  ticketId?: string | null;
  messageId?: string | null;
  userId?: string | null;
  /** Caller-supplied key that makes a retry of the same send a no-op. */
  idempotencyKey?: string | null;
}

export interface SendOutcome {
  delivered: boolean;
  providerMessageId?: string;
  error?: string;
  /** True when an idempotency key matched an earlier send. */
  deduplicated?: boolean;
}

export async function sendTenantMessage(
  tenantId: string,
  to: string,
  body: string,
  options: SendOptions = {}
): Promise<SendOutcome> {
  const number = normaliseNumber(to);
  if (!number) return { delivered: false, error: 'Not a valid WhatsApp number.' };
  if (body.trim() === '') return { delivered: false, error: 'Message body is empty.' };

  // Idempotency: an API client that retries after a timeout must not send the
  // customer a second copy. The key is stored on the message row, so the check
  // is a lookup rather than an in-memory cache that a restart would lose.
  if (options.idempotencyKey) {
    const existing = await queryOne<{ provider_message_id: string | null }>(
      `SELECT provider_message_id FROM whatsapp_messages
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, options.idempotencyKey]
    );
    if (existing) {
      return {
        delivered: true,
        providerMessageId: existing.provider_message_id ?? undefined,
        deduplicated: true,
      };
    }
  }

  const identity = await sendingIdentity(tenantId, options.numberId);

  // --- first-party fallback -------------------------------------------------
  if (!identity) {
    const result = await sendViaFirstPartyProvider(number, body, {
      ticketId: options.ticketId ?? null,
      messageId: options.messageId ?? null,
      userId: options.userId ?? null,
      tenantId,
    });

    if (result.delivered) await recordUsage(tenantId, 'message.sent', null, { path: 'first-party' });
    return { delivered: result.delivered, error: result.error };
  }

  // --- platform path --------------------------------------------------------
  try {
    const providerMessageId = await graph.sendText({
      phoneNumberId: identity.phoneNumberId,
      token: identity.token,
      to: number,
      body,
    });

    await query(
      `INSERT INTO whatsapp_messages
         (tenant_id, number_id, direction, provider_message_id, wa_number, body,
          ticket_id, message_id, user_id, status, provider, idempotency_key)
       VALUES ($1, $2, 'OUTBOUND', $3, $4, $5, $6, $7, $8, 'PENDING', 'meta', $9)`,
      [
        tenantId,
        identity.numberId,
        providerMessageId,
        number,
        body,
        options.ticketId ?? null,
        options.messageId ?? null,
        options.userId ?? null,
        options.idempotencyKey ?? null,
      ]
    );

    await recordUsage(tenantId, 'message.sent', identity.numberId, { to: `****${number.slice(-4)}` });

    await webhooks.emit(tenantId, 'message.sent', {
      message_id: providerMessageId,
      to: number,
      body,
    });

    return { delivered: true, providerMessageId };
  } catch (error) {
    const detail = describeFailure(error);

    // A failed delivery is recorded rather than thrown away: the tenant's
    // console is where they find out why a customer never replied.
    await query(
      `INSERT INTO whatsapp_messages
         (tenant_id, number_id, direction, wa_number, body, ticket_id, message_id,
          user_id, status, error_detail, provider, idempotency_key)
       VALUES ($1, $2, 'OUTBOUND', $3, $4, $5, $6, $7, 'FAILED', $8, 'meta', $9)`,
      [
        tenantId,
        identity.numberId,
        number,
        body,
        options.ticketId ?? null,
        options.messageId ?? null,
        options.userId ?? null,
        detail.slice(0, 500),
        options.idempotencyKey ?? null,
      ]
    );

    log.error({ tenantId, err: detail, to: `****${number.slice(-4)}` }, 'tenant send failed');
    return { delivered: false, error: detail };
  }
}

/**
 * Sends an approved template.
 *
 * Required whenever the business speaks first — outside the 24-hour window a
 * customer's own message opens, Meta accepts nothing else.
 */
export async function sendTenantTemplate(
  tenantId: string,
  to: string,
  template: { name: string; language: string; variables?: string[] },
  options: SendOptions = {}
): Promise<SendOutcome> {
  const number = normaliseNumber(to);
  if (!number) return { delivered: false, error: 'Not a valid WhatsApp number.' };

  const identity = await sendingIdentity(tenantId, options.numberId);
  if (!identity) {
    return { delivered: false, error: 'No connected WhatsApp number for this tenant.' };
  }

  try {
    const providerMessageId = await graph.sendTemplate({
      phoneNumberId: identity.phoneNumberId,
      token: identity.token,
      to: number,
      templateName: template.name,
      language: template.language,
      variables: template.variables,
    });

    await query(
      `INSERT INTO whatsapp_messages
         (tenant_id, number_id, direction, provider_message_id, wa_number, body, status, provider)
       VALUES ($1, $2, 'OUTBOUND', $3, $4, $5, 'PENDING', 'meta')`,
      [tenantId, identity.numberId, providerMessageId, number, `[template:${template.name}]`]
    );

    await recordUsage(tenantId, 'template.sent', identity.numberId, { template: template.name });

    return { delivered: true, providerMessageId };
  } catch (error) {
    const detail = describeFailure(error);
    log.error({ tenantId, err: detail }, 'template send failed');
    return { delivered: false, error: detail };
  }
}
