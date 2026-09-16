import crypto from 'node:crypto';
import { env } from '../../config/env';
import type { InboundMessage, OutboundMessage, SendResult, WhatsAppProvider } from './types';

/**
 * Twilio's WhatsApp API.
 *
 * Twilio was chosen over the Meta Cloud API for the real path because its
 * sandbox works within minutes of signing up — a phone joins by sending a code —
 * whereas Meta requires business verification that can take days. The provider
 * interface means swapping to Meta later touches only this file.
 *
 * Twilio prefixes WhatsApp addresses with "whatsapp:"; that detail is contained
 * here so the rest of the system deals in plain E.164 numbers.
 */
export class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'twilio';
  readonly simulated = false;

  private get endpoint(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${env.whatsappAccountSid}/Messages.json`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.whatsappTimeoutMs);

    try {
      const form = new URLSearchParams({
        To: `whatsapp:${message.to}`,
        From: `whatsapp:${env.whatsappFromNumber}`,
      });

      // Twilio's trial WhatsApp sender refuses free-form text (error 21654)
      // and only delivers pre-approved Content Templates. When a template SID
      // is configured the reply is carried in that template's variable; the
      // sandbox and production senders accept a plain Body instead.
      if (env.whatsappContentSid) {
        form.set('ContentSid', env.whatsappContentSid);
        form.set(
          'ContentVariables',
          JSON.stringify({ [env.whatsappContentVariable]: message.body })
        );
      } else {
        form.set('Body', message.body);
      }

      const auth = Buffer.from(
        `${env.whatsappAccountSid}:${env.whatsappAuthToken}`
      ).toString('base64');

      const response = await fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WhatsApp provider returned ${response.status}: ${text.slice(0, 200)}`);
      }

      const payload = (await response.json()) as { sid?: string; status?: string };
      if (!payload.sid) throw new Error('WhatsApp provider returned no message id.');

      return {
        providerMessageId: payload.sid,
        status: payload.status === 'queued' || payload.status === 'accepted' ? 'PENDING' : 'SENT',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Twilio posts a form-encoded body, already parsed into an object upstream. */
  parseWebhook(body: unknown): InboundMessage[] {
    const payload = body as Record<string, string | undefined>;
    if (!payload?.From || !payload?.Body || !payload?.MessageSid) return [];

    return [
      {
        providerMessageId: payload.MessageSid,
        from: payload.From.replace(/^whatsapp:/, ''),
        body: payload.Body,
      },
    ];
  }

  /**
   * Verifies Twilio's X-Twilio-Signature.
   *
   * Without this the webhook is an unauthenticated public endpoint, and anyone
   * who guessed the URL could raise tickets impersonating any phone number.
   */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const signature = headers['x-twilio-signature'];
    if (!signature || !env.whatsappAuthToken || !env.whatsappWebhookUrl) return false;

    // Twilio signs the URL followed by the POST parameters sorted by key.
    const params = new URLSearchParams(rawBody);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const payload = env.whatsappWebhookUrl + sorted.map(([k, v]) => k + v).join('');

    const expected = crypto
      .createHmac('sha1', env.whatsappAuthToken)
      .update(Buffer.from(payload, 'utf8'))
      .digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // Length check first: timingSafeEqual throws on a length mismatch.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
