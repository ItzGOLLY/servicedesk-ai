import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  Spinner,
  StatTile,
} from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { WhatsAppMessage, WhatsAppStatus } from '../../lib/types';

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  SENT: 'bg-sky-100 text-sky-800',
  DELIVERED: 'bg-emerald-100 text-emerald-800',
  READ: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

export default function WhatsAppConsole() {
  const queryClient = useQueryClient();

  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);
  const [simulate, setSimulate] = useState({ from: '+91', body: '' });
  const [actionError, setActionError] = useState('');
  const [actionNote, setActionNote] = useState('');

  const statusQuery = useQuery({
    queryKey: ['whatsapp', 'status'],
    queryFn: () => api.get<WhatsAppStatus>('/whatsapp/admin/status'),
    refetchInterval: 15_000,
  });

  const messagesQuery = useQuery({
    queryKey: ['whatsapp', 'messages', direction, page],
    queryFn: () =>
      api.get<WhatsAppMessage[]>(
        `/whatsapp/admin/messages${queryString({ direction, page, limit: 20 })}`
      ),
    refetchInterval: 15_000,
  });

  const sendSimulated = useMutation({
    mutationFn: () =>
      api.post<{ handled: boolean; reason: string; ticketReference?: string }>(
        '/whatsapp/admin/simulate',
        { from: simulate.from.trim(), body: simulate.body.trim() }
      ),
    onSuccess: (response) => {
      setActionError('');
      setActionNote(
        response.data.ticketReference
          ? `Message received — ${response.data.ticketReference} (${response.data.reason}).`
          : `Message received — ${response.data.reason}.`
      );
      setSimulate((prev) => ({ ...prev, body: '' }));
      void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => {
      setActionNote('');
      setActionError(err instanceof Error ? err.message : 'Could not deliver the message.');
    },
  });

  const handleSimulate = (event: FormEvent) => {
    event.preventDefault();
    setActionError('');
    setActionNote('');
    sendSimulated.mutate();
  };

  if (statusQuery.isLoading) return <LoadingBlock />;
  if (statusQuery.isError) {
    return <ErrorNotice message={(statusQuery.error as Error).message} />;
  }

  const status = statusQuery.data!.data;
  const messages = messagesQuery.data?.data ?? [];
  const meta = messagesQuery.data?.meta;

  return (
    <div>
      <PageHeader
        title="WhatsApp channel"
        subtitle="Customers raise and follow tickets from WhatsApp; agent replies are delivered back to their chat."
      />

      {/* The active provider is stated plainly rather than implied. */}
      <Card
        className={`mb-6 p-5 ${status.simulated ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-ink">
              {status.simulated ? 'Running in simulator mode' : `Connected via ${status.activeProvider}`}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              {status.simulated
                ? 'Messages are recorded and shown here but not delivered to a real phone. Set WHATSAPP_PROVIDER=twilio with credentials to send for real.'
                : `Sending from ${status.fromNumber ?? 'the configured number'}.`}
            </p>
          </div>
          <span
            className={`badge ${status.simulated ? 'bg-amber-200 text-amber-900' : 'bg-emerald-200 text-emerald-900'}`}
          >
            {status.activeProvider}
          </span>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Tickets from WhatsApp" value={status.ticketsFromWhatsApp} />
        <StatTile label="Messages received" value={status.inboundMessages} accent="text-blue-600" />
        <StatTile label="Messages sent" value={status.outboundMessages} accent="text-emerald-600" />
        <StatTile
          label="Failed deliveries"
          value={status.failedMessages}
          accent={status.failedMessages > 0 ? 'text-rose-600' : 'text-slate-400'}
          hint={status.failedMessages > 0 ? 'Check the log below' : 'None'}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Simulated inbound — how the channel is demonstrated without a phone */}
        <Card className="p-5">
          <h2 className="font-semibold text-ink">Send a test message</h2>
          <p className="mt-1 text-sm text-slate-500">
            Delivers a message as if a customer had sent it from their phone. The full inbound path
            runs — a ticket is raised, classified and answered.
          </p>

          {actionError && (
            <div className="mt-4">
              <ErrorNotice message={actionError} />
            </div>
          )}
          {actionNote && (
            <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
              {actionNote}
            </p>
          )}

          <form onSubmit={handleSimulate} className="mt-5 space-y-4" noValidate>
            <div>
              <label htmlFor="from" className="label">
                Customer number
              </label>
              <input
                id="from"
                className="input"
                value={simulate.from}
                onChange={(e) => setSimulate((p) => ({ ...p, from: e.target.value }))}
                placeholder="+919000000001"
                required
              />
              <p className="mt-1.5 text-xs text-slate-500">
                International format. A number we have not seen creates a new customer.
              </p>
            </div>

            <div>
              <label htmlFor="body" className="label">
                Message
              </label>
              <textarea
                id="body"
                className="input min-h-28 resize-y"
                value={simulate.body}
                onChange={(e) => setSimulate((p) => ({ ...p, body: e.target.value }))}
                placeholder="My payment was deducted but my order is still pending."
                required
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Try <span className="font-semibold">STATUS</span>,{' '}
                <span className="font-semibold">HELP</span> or{' '}
                <span className="font-semibold">CLOSE</span> to exercise the keywords.
              </p>
            </div>

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={sendSimulated.isPending || simulate.body.trim().length === 0}
            >
              {sendSimulated.isPending ? (
                <>
                  <Spinner className="h-4 w-4" /> Delivering…
                </>
              ) : (
                'Deliver message'
              )}
            </button>
          </form>
        </Card>

        {/* Message log */}
        <Card className="lg:col-span-2">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-semibold text-ink">Message log</h2>
            <select
              className="input sm:w-44"
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by direction"
            >
              <option value="">All messages</option>
              <option value="INBOUND">Received</option>
              <option value="OUTBOUND">Sent</option>
            </select>
          </div>

          {messagesQuery.isLoading ? (
            <LoadingBlock />
          ) : messages.length === 0 ? (
            <EmptyState
              title="No messages yet"
              message="Send a test message on the left to see the channel working end to end."
            />
          ) : (
            <>
              <ul>
                {messages.map((message) => (
                  <li key={message.id} className="border-b border-slate-100 px-5 py-4 last:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`badge ${
                          message.direction === 'INBOUND'
                            ? 'bg-brand-100 text-brand-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {message.direction === 'INBOUND' ? 'Received' : 'Sent'}
                      </span>
                      <span className={`badge ${STATUS_STYLES[message.status] ?? 'bg-slate-100'}`}>
                        {message.status}
                      </span>
                      {/* Numbers are masked by the API; the console never shows them in full. */}
                      <span className="font-mono text-xs text-slate-500">{message.number}</span>
                      {message.ticketReference && (
                        <span className="text-xs font-semibold text-brand-600">
                          {message.ticketReference}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-slate-400" title={formatDateTime(message.createdAt)}>
                        {timeAgo(message.createdAt)}
                      </span>
                    </div>

                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>

                    {message.error && (
                      <p className="mt-2 rounded bg-rose-50 px-3 py-1.5 text-xs text-rose-800">
                        {message.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {meta && (
                <Pagination
                  page={meta.page}
                  totalPages={meta.totalPages}
                  total={meta.total}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="font-semibold text-ink">How customers use it</h2>
        <ul className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <li>Send any description of a problem — a ticket is raised and classified automatically.</li>
          <li>Reply again and the message is added to the same ticket, not a new one.</li>
          <li>
            <span className="font-semibold text-ink">STATUS</span> lists their open requests.
          </li>
          <li>
            <span className="font-semibold text-ink">CLOSE</span> closes a resolved request.
          </li>
        </ul>
        <p className="mt-4 text-xs text-slate-500">
          Every outbound message is plain text — WhatsApp renders no Markdown, so agent replies are
          converted before sending. See{' '}
          <Link to="/admin/tickets" className="font-semibold text-brand-600 hover:underline">
            all tickets
          </Link>{' '}
          to view WhatsApp conversations alongside web ones.
        </p>
      </Card>
    </div>
  );
}
