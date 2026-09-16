import crypto from 'node:crypto';
import { env } from '../../config/env';
import type { InboundMessage, OutboundMessage, SendResult, WhatsAppProvider } from './types';

/**
 * Meta's WhatsApp Cloud API, called directly.
 *
 * Meta's free test number delivers free-form text inside the 24-hour customer
 * service window that a customer's own message opens, which is exactly the
 * pattern this channel uses: the customer always writes first. Twilio's trial
 * tier refuses free-form text altogether, so this is the no-cost path to real
 * replies. Same interface as the Twilio provider, so nothing else changes.
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta';
  readonly simulated = false;

  private get endpoint(): string {
    return `https://graph.facebook.com/${env.whatsappGraphVersion}/${env.whatsappPhoneNumberId}/messages`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.whatsappTimeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${env.whatsappAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          // The Graph API takes the number without the leading "+".
          to: message.to.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body: message.body },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WhatsApp provider returned ${response.status}: ${text.slice(0, 200)}`);
      }

      const payload = (await response.json()) as { messages?: Array<{ id?: string }> };
      const id = payload.messages?.[0]?.id;
      if (!id) throw new Error('WhatsApp provider returned no message id.');

      // The Cloud API accepts the message for delivery; a later status webhook
      // (which this channel ignores) would report sent/delivered/read.
      return { providerMessageId: id, status: 'PENDING' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Meta posts JSON: entry[].changes[].value.messages[]. Delivery-status
   * callbacks arrive on the same URL with `statuses` instead of `messages`,
   * and media or reactions have no text body; all of those yield nothing.
   */
  parseWebhook(body: unknown): InboundMessage[] {
    const payload = body as MetaWebhookBody | undefined;
    if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      return [];
    }

    const inbound: InboundMessage[] = [];
    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (message.type !== 'text' || !message.id || !message.from || !message.text?.body) {
            continue;
          }
          inbound.push({
            providerMessageId: message.id,
            from: `+${message.from.replace(/^\+/, '')}`,
            body: message.text.body,
          });
        }
      }
    }
    return inbound;
  }

  /**
   * Verifies Meta's X-Hub-Signature-256: an HMAC-SHA256 of the raw body keyed
   * with the app secret. Same reasoning as the Twilio check — without it the
   * webhook is a public endpoint that could raise tickets as any number.
   */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const header = headers['x-hub-signature-256'];
    if (!header || !env.whatsappAppSecret) return false;

    const signature = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
    const expected = crypto
      .createHmac('sha256', env.whatsappAppSecret)
      .update(Buffer.from(rawBody, 'utf8'))
      .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}
