import type { TicketPriority, TicketSentiment } from '../../types';

export interface ClassificationResult {
  category: string;
  priority: TicketPriority;
  sentiment: TicketSentiment;
  summary: string;
  confidence: number;
}

export interface DraftReplyResult {
  draft: string;
}

export interface SummaryResult {
  summary: string;
}

export interface ResolutionStepsResult {
  steps: string[];
}

export interface TicketContext {
  subject: string;
  description: string;
  categories: string[];
}

export interface ConversationContext {
  subject: string;
  description: string;
  customerName: string;
  messages: { author: string; body: string }[];
}

/**
 * Both the real provider and the rule-based fallback implement this, so calling
 * code never branches on which one is active.
 */
export interface AiProvider {
  readonly name: string;
  classify(ctx: TicketContext): Promise<ClassificationResult>;
  draftReply(ctx: ConversationContext): Promise<DraftReplyResult>;
  summarise(ctx: ConversationContext): Promise<SummaryResult>;
  resolutionSteps(ctx: ConversationContext): Promise<ResolutionStepsResult>;
}
