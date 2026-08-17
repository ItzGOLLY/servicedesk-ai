import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Spinner } from './ui';
import { SentimentBadge } from './TicketBits';
import type { Ticket } from '../lib/types';

/**
 * The AI assistance panel.
 *
 * Every control here produces a *suggestion*. The draft is handed to the
 * agent's own reply box via onUseDraft — this component never sends anything to
 * a customer, which is the guarantee the whole feature rests on.
 */
export default function AiPanel({
  ticket,
  onUseDraft,
}: {
  ticket: Ticket;
  onUseDraft: (draft: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(ticket.aiSummary);
  const [steps, setSteps] = useState<string[] | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState('');

  const draftMutation = useMutation({
    mutationFn: () =>
      api.post<{ draft: string; usedFallback: boolean }>(`/ai/tickets/${ticket.id}/draft-reply`),
    onSuccess: (response) => {
      setDraft(response.data.draft);
      setDegraded(response.data.usedFallback);
      setError('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'AI assistance is unavailable.'),
  });

  const summaryMutation = useMutation({
    mutationFn: () =>
      api.post<{ summary: string; usedFallback: boolean }>(`/ai/tickets/${ticket.id}/summary`),
    onSuccess: (response) => {
      setSummary(response.data.summary);
      setDegraded(response.data.usedFallback);
      setError('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'AI assistance is unavailable.'),
  });

  const stepsMutation = useMutation({
    mutationFn: () =>
      api.post<{ steps: string[]; usedFallback: boolean }>(`/ai/tickets/${ticket.id}/resolution-steps`),
    onSuccess: (response) => {
      setSteps(response.data.steps);
      setDegraded(response.data.usedFallback);
      setError('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'AI assistance is unavailable.'),
  });

  const busy =
    draftMutation.isPending || summaryMutation.isPending || stepsMutation.isPending;

  return (
    <div className="rounded-xl border border-sea/40 bg-brand-50">
      <div className="flex items-center gap-2 border-b border-sea/30 px-5 py-4">
        <div className="h-2.5 w-2.5 rounded-full bg-sea" />
        <h3 className="font-semibold text-ink">AI assistance</h3>
        {busy && <Spinner className="h-4 w-4 text-brand-600" />}
      </div>

      <div className="space-y-5 px-5 py-5">
        {/* Classification produced when the ticket was raised */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Classification
          </p>
          {ticket.aiClassifiedAt ? (
            <>
              <dl className="mt-2.5 grid grid-cols-3 gap-3">
                <div>
                  <dt className="text-xs text-slate-500">Category</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-ink">
                    {ticket.category?.name ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Priority</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-ink">{ticket.priority}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Sentiment</dt>
                  <dd className="mt-1">
                    <SentimentBadge sentiment={ticket.sentiment} />
                  </dd>
                </div>
              </dl>
              {ticket.aiConfidence !== null && (
                <p className="mt-2 text-xs text-slate-500">
                  Confidence {Math.round(ticket.aiConfidence * 100)}% — you can override any field.
                </p>
              )}
            </>
          ) : (
            <p className="mt-1.5 text-sm text-slate-600">
              This ticket has not been classified. Triage it manually using the controls above.
            </p>
          )}
        </div>

        {/* Summary */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Summary</p>
            <button
              type="button"
              className="text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
              onClick={() => summaryMutation.mutate()}
              disabled={busy}
            >
              {summary ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          <p className="mt-1.5 text-sm text-slate-700">
            {summary ?? 'No summary generated yet.'}
          </p>
        </div>

        {/* Suggested resolution steps */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Suggested steps
            </p>
            <button
              type="button"
              className="text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
              onClick={() => stepsMutation.mutate()}
              disabled={busy}
            >
              {steps ? 'Regenerate' : 'Suggest'}
            </button>
          </div>
          {steps ? (
            <ol className="mt-2 space-y-1.5">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-2 text-sm text-slate-700">
                  <span className="font-semibold text-brand-600">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1.5 text-sm text-slate-600">No suggestions generated yet.</p>
          )}
        </div>

        {/* Draft reply */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Draft reply
            </p>
            <button
              type="button"
              className="text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
              onClick={() => draftMutation.mutate()}
              disabled={busy}
            >
              {draft ? 'Regenerate' : 'Generate'}
            </button>
          </div>

          {draft ? (
            <>
              <textarea
                className="input mt-2 min-h-36 resize-y bg-white text-sm"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="AI draft reply"
              />
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" className="btn-primary px-3 py-2 text-xs" onClick={() => onUseDraft(draft)}>
                  Insert into reply
                </button>
                <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setDraft(null)}>
                  Discard
                </button>
              </div>
              <p className="mt-2 text-xs font-medium text-brand-700">
                Review and edit this draft before sending it to the customer.
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-sm text-slate-600">
              Generate a draft to start from, then edit it in your own words.
            </p>
          )}
        </div>

        {/* Degradation and error states are shown plainly, never hidden. */}
        {degraded && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            The AI provider was unavailable, so these suggestions came from the built-in rule-based
            assistant. Everything else on this ticket works normally.
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error} You can still write and send the reply yourself.
          </p>
        )}
      </div>
    </div>
  );
}
