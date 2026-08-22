import type { InboundMessage, OutboundMessage, SendResult, WhatsAppProvider } from './types';

/**
 * A WhatsApp provider that sends nothing.
 *
 * This is what makes the feature demonstrable and testable without a Meta
 * business account, a verified number or network access. Outbound messages are
 * recorded in the database exactly as a real send would be and surfaced in the
 * admin console, so the whole two-way flow can be exercised end to end.
 *
 * It also keeps a demonstration safe: an external provider outage cannot break
 * the walkthrough.
 */
export class SimulatorWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'simulator';
  readonly simulated = true;

  private counter = 0;

  async send(message: OutboundMessage): Promise<SendResult> {
    this.counter += 1;
    // Logged so the outbound text is visible while developing.
    console.log(`[whatsapp:simulator] → ${message.to}\n${message.body}\n`);
    return {
      providerMessageId: `sim-${Date.now()}-${this.counter}`,
      status: 'SENT',
    };
  }

  /**
   * Accepts the same simple shape the admin console's test form posts,
   * so an inbound message can be simulated without a provider.
   */
  parseWebhook(body: unknown): InboundMessage[] {
    const payload = body as { from?: unknown; body?: unknown; messageId?: unknown };
    if (typeof payload?.from !== 'string' || typeof payload?.body !== 'string') return [];

    return [
      {
        providerMessageId:
          typeof payload.messageId === 'string' && payload.messageId
            ? payload.messageId
            : `sim-in-${Date.now()}`,
        from: payload.from,
        body: payload.body,
      },
    ];
  }

  /** Nothing to verify — the simulator route is admin-authenticated instead. */
  verifySignature(): boolean {
    return true;
  }
}
