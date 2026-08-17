import type {
  AiProvider,
  ClassificationResult,
  ConversationContext,
  DraftReplyResult,
  ResolutionStepsResult,
  SummaryResult,
  TicketContext,
} from './types';
import type { TicketPriority, TicketSentiment } from '../../types';

/**
 * Deterministic, offline classifier.
 *
 * This is what keeps the AI feature from being a single point of failure. It
 * runs when no API key is configured and whenever the real provider errors or
 * times out, so the product still classifies tickets and still offers the agent
 * a starting draft. It uses keyword matching — no network, no cost, no latency.
 */

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Billing: [
    'payment', 'refund', 'invoice', 'charge', 'charged', 'billing', 'bill',
    'subscription', 'card', 'deducted', 'money', 'price', 'overcharged',
  ],
  Technical: [
    'error', 'bug', 'crash', 'crashes', 'broken', 'not working', 'fails',
    'failed', 'loading', 'slow', 'freeze', 'glitch', 'timeout', 'blank',
  ],
  Delivery: [
    'delivery', 'shipping', 'shipment', 'courier', 'order', 'package',
    'parcel', 'dispatch', 'tracking', 'delayed', 'wrong item',
  ],
  Account: [
    'login', 'log in', 'password', 'sign in', 'account', 'register',
    'verification', 'otp', 'locked', 'reset', 'email address', 'profile',
  ],
};

const URGENT_TERMS = ['urgent', 'immediately', 'asap', 'critical', 'emergency', 'outage'];
const HIGH_TERMS = [
  'not working', 'cannot', "can't", 'failed', 'deducted', 'unable', 'broken',
  'crash', 'lost', 'missing', 'refund', 'wrong',
];
const LOW_TERMS = ['question', 'how do i', 'clarification', 'suggestion', 'wondering', 'change'];

const NEGATIVE_TERMS = [
  'angry', 'terrible', 'worst', 'unacceptable', 'frustrated', 'disappointed',
  'poor', 'awful', 'ridiculous', 'complaint', 'still not', 'again', 'never',
];
const POSITIVE_TERMS = ['thanks', 'thank you', 'great', 'appreciate', 'happy', 'excellent', 'good'];

function countMatches(haystack: string, needles: string[]): number {
  return needles.reduce((total, needle) => (haystack.includes(needle) ? total + 1 : total), 0);
}

function pickCategory(text: string, available: string[]): { category: string; score: number } {
  let best = { category: 'General', score: 0 };

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = countMatches(text, keywords);
    if (score > best.score) best = { category, score };
  }

  // Only propose a category the business actually has configured.
  if (best.score > 0 && available.length > 0) {
    const match = available.find((c) => c.toLowerCase() === best.category.toLowerCase());
    if (!match) return { category: available[0] ?? 'General', score: 0 };
    return { category: match, score: best.score };
  }

  return best.score > 0 ? best : { category: available[0] ?? 'General', score: 0 };
}

function pickPriority(text: string): TicketPriority {
  if (countMatches(text, URGENT_TERMS) > 0) return 'URGENT';
  if (countMatches(text, HIGH_TERMS) >= 1) return 'HIGH';
  if (countMatches(text, LOW_TERMS) >= 1) return 'LOW';
  return 'MEDIUM';
}

function pickSentiment(text: string): TicketSentiment {
  const negative = countMatches(text, NEGATIVE_TERMS);
  const positive = countMatches(text, POSITIVE_TERMS);
  if (negative > positive) return 'NEGATIVE';
  if (positive > negative) return 'POSITIVE';
  return 'NEUTRAL';
}

/** First sentence, capped — enough to identify the ticket in a list. */
function summarise(subject: string, description: string): string {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  const base = firstSentence.length >= 20 ? firstSentence : `${subject}. ${description}`.trim();
  return base.length > 160 ? `${base.slice(0, 157).trimEnd()}...` : base;
}

export class FallbackAiProvider implements AiProvider {
  readonly name = 'rule-based-fallback';

  async classify(ctx: TicketContext): Promise<ClassificationResult> {
    const text = `${ctx.subject} ${ctx.description}`.toLowerCase();
    const { category, score } = pickCategory(text, ctx.categories);

    return {
      category,
      priority: pickPriority(text),
      sentiment: pickSentiment(text),
      summary: summarise(ctx.subject, ctx.description),
      // Honest confidence: keyword matching is weaker than a model, and the UI
      // shows this number so the agent knows how much to trust it.
      confidence: Math.min(0.6, 0.25 + score * 0.1),
    };
  }

  async draftReply(ctx: ConversationContext): Promise<DraftReplyResult> {
    const firstName = ctx.customerName.split(' ')[0] ?? 'there';
    return {
      draft:
        `Hi ${firstName},\n\n` +
        `Thank you for contacting us about "${ctx.subject}".\n\n` +
        `I have reviewed the details you shared and I am looking into this now. ` +
        `I will update you as soon as I have more information.\n\n` +
        `If anything changes at your end in the meantime, please reply on this ticket.\n\n` +
        `Best regards,\nCustomer Support`,
    };
  }

  async summarise(ctx: ConversationContext): Promise<SummaryResult> {
    const replies = ctx.messages.length;
    return {
      summary:
        `${summarise(ctx.subject, ctx.description)}` +
        (replies > 0 ? ` (${replies} ${replies === 1 ? 'reply' : 'replies'} in thread)` : ''),
    };
  }

  async resolutionSteps(ctx: ConversationContext): Promise<ResolutionStepsResult> {
    const text = `${ctx.subject} ${ctx.description}`.toLowerCase();
    const { category } = pickCategory(text, []);

    const playbooks: Record<string, string[]> = {
      Billing: [
        'Confirm the transaction reference and the amount with the customer.',
        'Check the payment gateway record for the transaction status.',
        'If payment succeeded but the order did not update, trigger a manual reconciliation.',
        'If the charge was genuinely duplicated, raise a refund and share the expected timeline.',
      ],
      Technical: [
        'Ask for the device, browser and app version, plus a screenshot if possible.',
        'Attempt to reproduce the issue on a matching configuration.',
        'Check the server logs around the reported time for related errors.',
        'If reproducible, escalate to engineering with the reproduction steps attached.',
      ],
      Delivery: [
        'Confirm the order number and delivery address on file.',
        'Check the courier tracking status for the shipment.',
        'If the shipment has stalled, open a trace request with the courier.',
        'Offer the customer a redelivery or refund depending on the trace outcome.',
      ],
      Account: [
        'Verify the identity of the requester before making any account change.',
        'Check whether the account is active and not locked by failed attempts.',
        'Send a fresh password reset link and confirm the customer receives it.',
        'If email delivery is failing, check the spam route and the address on file.',
      ],
    };

    return {
      steps: playbooks[category] ?? [
        'Acknowledge the request and confirm the details with the customer.',
        'Identify which team owns the underlying issue.',
        'Agree a next update time with the customer and record it on the ticket.',
      ],
    };
  }
}
