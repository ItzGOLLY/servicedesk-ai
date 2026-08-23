import { env } from '../../config/env';
import { query, queryOne } from '../../db/pool';
import { notifyAdmins } from '../notifications';
import { SimulatorWhatsAppProvider } from './simulator.provider';
import { TwilioWhatsAppProvider } from './twilio.provider';
import type { InboundMessage, WhatsAppProvider } from './types';
import { loggerFor } from '../../observability/logger';

const log = loggerFor('whatsapp');

export * from './types';
export * as templates from './format';

const simulator = new SimulatorWhatsAppProvider();

/**
 * Selects the provider from configuration.
 *
 * Asking for the real provider without credentials would fail on every send, so
 * that combination degrades to the simulator at boot with a warning rather than
 * failing later in front of an audience.
 */
function selectProvider(): WhatsAppProvider {
  if (env.whatsappProvider === 'twilio') {
    if (!env.whatsappAccountSid || !env.whatsappAuthToken || !env.whatsappFromNumber) {
      log.warn('[whatsapp] provider=twilio but credentials are incomplete — using simulator.');
      return simulator;
    }
    return new TwilioWhatsAppProvider();
  }
  return simulator;
}

const provider = selectProvider();

export const whatsappStatus = {
  configured: env.whatsappProvider,
  active: provider.name,
  simulated: provider.simulated,
  fromNumber: env.whatsappFromNumber || null,
};

/**
 * Normalises a number to E.164, the single format stored and sent to.
 * Returns null when the value cannot be a phone number, so a malformed webhook
 * never creates a user keyed on nonsense.
 */
export function normaliseNumber(raw: string): string | null {
  const trimmed = raw.trim().replace(/^whatsapp:/i, '');
  const digits = trimmed.replace(/[^\d+]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

export function parseWebhook(body: unknown): InboundMessage[] {
  return provider.parseWebhook(body);
}

export function verifySignature(
  rawBody: string,
  headers: Record<string, string | undefined>
): boolean {
  return provider.verifySignature(rawBody, headers);
}

export interface SendOptions {
  ticketId?: string | null;
  messageId?: string | null;
  userId?: string | null;
}

/**
 * Sends a message and records it.
 *
 * Delivery is best-effort by design: a WhatsApp failure must never roll back the
 * ticket change that triggered it. The agent's reply is already saved and
 * visible in the web application; a failed delivery is recorded with its error
 * so an admin can see it, and the caller is told without being made to care.
 */
export async function sendMessage(
  to: string,
  body: string,
  options: SendOptions = {}
): Promise<{ delivered: boolean; error?: string }> {
  const number = normaliseNumber(to);
  if (!number) return { delivered: false, error: 'Not a valid WhatsApp number.' };

  try {
    const result = await provider.send({ to: number, body });

    await query(
      `INSERT INTO whatsapp_messages
         (direction, provider_message_id, wa_number, body, ticket_id, message_id, user_id, status, provider)
       VALUES ('OUTBOUND', $1, $2, $3, $4, $5, $6, $7::wa_delivery_status, $8)`,
      [
        result.providerMessageId,
        number,
        body,
        options.ticketId ?? null,
        options.messageId ?? null,
        options.userId ?? null,
        result.status,
        provider.name,
      ]
    );

    return { delivered: true };
  } catch (error) {
    const detail = (error as Error).message;
    log.error({ err: detail, to: `****${number.slice(-4)}` }, 'WhatsApp send failed');

    // Recorded as FAILED so the failure is visible rather than silent.
    try {
      await query(
        `INSERT INTO whatsapp_messages
           (direction, wa_number, body, ticket_id, message_id, user_id, status, error_detail, provider)
         VALUES ('OUTBOUND', $1, $2, $3, $4, $5, 'FAILED', $6, $7)`,
        [
          number,
          body,
          options.ticketId ?? null,
          options.messageId ?? null,
          options.userId ?? null,
          detail.slice(0, 500),
          provider.name,
        ]
      );
    } catch (logError) {
      log.error({ err: (logError as Error).message }, 'could not record WhatsApp failure');
    }

    // A permanently failed delivery is an operational problem a human must see:
    // the customer is waiting on a reply that never arrived. Admins have a
    // console for exactly this, so they are told rather than left to notice.
    await notifyAdmins(
      'TICKET_REPLY',
      'WhatsApp delivery failed',
      `A message to ••••${number.slice(-4)} could not be delivered. See the WhatsApp console.`,
      options.ticketId ?? null
    );

    return { delivered: false, error: detail };
  }
}

/**
 * Sends to a ticket's customer only if that customer reached us on WhatsApp.
 * Used by the reply and status-change paths, which must not assume a channel.
 */
export async function notifyTicketCustomer(
  ticketId: string,
  body: string,
  messageId: string | null = null
): Promise<void> {
  const row = await queryOne<{ whatsapp_number: string | null; customer_id: string; channel: string }>(
    `SELECT u.whatsapp_number, t.customer_id, t.channel::TEXT AS channel
       FROM tickets t JOIN users u ON u.id = t.customer_id
      WHERE t.id = $1`,
    [ticketId]
  );

  if (!row?.whatsapp_number || row.channel !== 'WHATSAPP') return;

  await sendMessage(row.whatsapp_number, body, {
    ticketId,
    messageId,
    userId: row.customer_id,
  });
}
