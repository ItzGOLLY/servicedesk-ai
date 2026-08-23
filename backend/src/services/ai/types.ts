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

/** One knowledge-base passage supplied to the model as reference material. */
export interface GroundingPassage {
  id: string;
  title: string;
  content: string;
}

export interface GroundedAnswerResult {
  answer: string;
  /** Ids of the passages the model reported using. */
  citedIds: string[];
  /** True when the model judged the passages insufficient to answer. */
  insufficient: boolean;
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
  /** Answers strictly from the supplied passages, or reports it cannot. */
  answerFromKnowledge(
    ctx: ConversationContext,
    passages: GroundingPassage[]
  ): Promise<GroundedAnswerResult>;
}
