export interface OutboundMessage {
  to: string;
  body: string;
}

export interface SendResult {
  /** The provider's own message id, used later to match delivery callbacks. */
  providerMessageId: string;
  status: 'SENT' | 'PENDING';
}

/** A normalised inbound message, whatever shape the provider posted. */
export interface InboundMessage {
  providerMessageId: string;
  from: string;
  body: string;
}

/**
 * Both the real client and the simulator implement this, so nothing that sends
 * a message needs to know which is active.
 */
export interface WhatsAppProvider {
  readonly name: string;
  /** True when messages are not actually leaving the machine. */
  readonly simulated: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Normalises a provider-specific webhook body. Returns [] if not a message. */
  parseWebhook(body: unknown): InboundMessage[];
  /** Verifies the webhook really came from the provider. */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean;
}
