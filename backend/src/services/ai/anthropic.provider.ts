import { env } from '../../config/env';
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

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const SENTIMENTS: TicketSentiment[] = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'];

/**
 * Calls the Claude API from the backend only.
 *
 * The API key lives in a server environment variable and is never sent to the
 * browser — the frontend asks our own /api/ai/* routes, and this class is the
 * only code that talks to the provider.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly name = env.aiModel;

  /**
   * One request helper for all four capabilities.
   * An AbortController enforces the timeout so a slow provider cannot hold a
   * request open indefinitely and exhaust the connection pool.
   */
  private async send(system: string, userPrompt: string, maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.aiTimeoutMs);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.aiApiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: env.aiModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`AI provider returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = (await response.json()) as {
        content?: { type: string; text?: string }[];
      };

      const text = payload.content?.find((block) => block.type === 'text')?.text;
      if (!text) throw new Error('AI provider returned no text content.');
      return text.trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Models occasionally wrap JSON in prose or a code fence; recover the object. */
  private parseJson<T>(raw: string): T {
    const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('AI response contained no JSON object.');
    return JSON.parse(fenced.slice(start, end + 1)) as T;
  }

  async classify(ctx: TicketContext): Promise<ClassificationResult> {
    const categoryList = ctx.categories.length ? ctx.categories.join(', ') : 'General';

    const system =
      'You triage customer support tickets for a small business. ' +
      'Reply with a single JSON object and nothing else. Keys: ' +
      '"category" (one of the allowed categories), ' +
      '"priority" (LOW, MEDIUM, HIGH or URGENT), ' +
      '"sentiment" (POSITIVE, NEUTRAL or NEGATIVE), ' +
      '"summary" (one sentence, under 160 characters), ' +
      '"confidence" (number between 0 and 1).';

    const raw = await this.send(
      system,
      `Allowed categories: ${categoryList}\n\nSubject: ${ctx.subject}\n\nDescription: ${ctx.description}`,
      400
    );

    const parsed = this.parseJson<Record<string, unknown>>(raw);

    // Never trust the model's field values directly — they go into typed enum
    // columns, so anything unexpected falls back to a safe default.
    const category = String(parsed.category ?? '').trim();
    const priority = String(parsed.priority ?? '').toUpperCase() as TicketPriority;
    const sentiment = String(parsed.sentiment ?? '').toUpperCase() as TicketSentiment;
    const confidence = Number(parsed.confidence);

    return {
      category:
        ctx.categories.find((c) => c.toLowerCase() === category.toLowerCase()) ??
        ctx.categories[0] ??
        'General',
      priority: PRIORITIES.includes(priority) ? priority : 'MEDIUM',
      sentiment: SENTIMENTS.includes(sentiment) ? sentiment : 'NEUTRAL',
      summary: String(parsed.summary ?? '').slice(0, 300) || ctx.subject,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    };
  }

  async draftReply(ctx: ConversationContext): Promise<DraftReplyResult> {
    const system =
      'You draft replies for a human support agent to review and edit. ' +
      'Be warm, specific and concise. Never promise a refund, compensation or a ' +
      'delivery date. Never invent order details, policies or facts not present ' +
      'in the ticket. Sign off as "Customer Support". Return only the reply text.';

    const draft = await this.send(system, this.renderConversation(ctx), 700);
    return { draft };
  }

  async summarise(ctx: ConversationContext): Promise<SummaryResult> {
    const system =
      'Summarise this support conversation for an agent picking it up cold. ' +
      'Two sentences maximum: the problem, and where it currently stands. ' +
      'Return only the summary text.';

    const summary = await this.send(system, this.renderConversation(ctx), 250);
    return { summary };
  }

  async resolutionSteps(ctx: ConversationContext): Promise<ResolutionStepsResult> {
    const system =
      'Suggest concrete troubleshooting steps for the support agent. ' +
      'Reply with a JSON object: {"steps": ["...", "..."]}. ' +
      'Three to five steps, each one short imperative sentence.';

    const raw = await this.send(system, this.renderConversation(ctx), 500);
    const parsed = this.parseJson<{ steps?: unknown }>(raw);

    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s) => String(s)).filter(Boolean).slice(0, 6)
      : [];

    if (steps.length === 0) throw new Error('AI response contained no steps.');
    return { steps };
  }

  private renderConversation(ctx: ConversationContext): string {
    const thread = ctx.messages
      .map((m) => `${m.author}: ${m.body}`)
      .join('\n\n');

    return (
      `Customer: ${ctx.customerName}\n` +
      `Subject: ${ctx.subject}\n\n` +
      `Original message:\n${ctx.description}` +
      (thread ? `\n\nConversation so far:\n${thread}` : '')
    );
  }
}
