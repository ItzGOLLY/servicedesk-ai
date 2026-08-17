import { env } from '../../config/env';
import { AnthropicAiProvider } from './anthropic.provider';
import { FallbackAiProvider } from './fallback.provider';
import type {
  AiProvider,
  ClassificationResult,
  ConversationContext,
  DraftReplyResult,
  ResolutionStepsResult,
  SummaryResult,
  TicketContext,
} from './types';

export * from './types';

const fallback = new FallbackAiProvider();

/**
 * Chooses the provider from configuration.
 * Requesting the real provider without a key would fail on every call, so that
 * combination degrades to the fallback at boot with a warning rather than
 * failing later in front of an audience.
 */
function selectProvider(): AiProvider {
  if (env.aiProvider === 'anthropic') {
    if (!env.aiApiKey) {
      console.warn('[ai] AI_PROVIDER=anthropic but AI_API_KEY is empty — using fallback.');
      return fallback;
    }
    return new AnthropicAiProvider();
  }
  return fallback;
}

const provider = selectProvider();

/** Reported by GET /api/ai/health so an admin can see which engine is live. */
export const aiStatus = {
  configured: env.aiProvider,
  active: provider.name,
  usingFallback: provider === fallback,
};

export interface AiOutcome<T> {
  result: T;
  usedFallback: boolean;
  model: string;
}

/**
 * Runs an AI capability, degrading to the rule-based provider on any failure.
 *
 * This wrapper is the whole graceful-degradation story: a provider outage, a
 * timeout, a rate limit or a malformed response all end up here, and the caller
 * still receives a usable result plus a flag saying the fallback produced it.
 */
async function attempt<T>(
  operation: string,
  primary: () => Promise<T>,
  degraded: () => Promise<T>
): Promise<AiOutcome<T>> {
  if (provider === fallback) {
    return { result: await degraded(), usedFallback: true, model: fallback.name };
  }

  try {
    return { result: await primary(), usedFallback: false, model: provider.name };
  } catch (error) {
    console.warn(`[ai] ${operation} failed (${(error as Error).message}) — using fallback.`);
    return { result: await degraded(), usedFallback: true, model: fallback.name };
  }
}

export function classifyTicket(ctx: TicketContext): Promise<AiOutcome<ClassificationResult>> {
  return attempt('classify', () => provider.classify(ctx), () => fallback.classify(ctx));
}

export function draftReply(ctx: ConversationContext): Promise<AiOutcome<DraftReplyResult>> {
  return attempt('draftReply', () => provider.draftReply(ctx), () => fallback.draftReply(ctx));
}

export function summariseTicket(ctx: ConversationContext): Promise<AiOutcome<SummaryResult>> {
  return attempt('summarise', () => provider.summarise(ctx), () => fallback.summarise(ctx));
}

export function resolutionSteps(
  ctx: ConversationContext
): Promise<AiOutcome<ResolutionStepsResult>> {
  return attempt(
    'resolutionSteps',
    () => provider.resolutionSteps(ctx),
    () => fallback.resolutionSteps(ctx)
  );
}
