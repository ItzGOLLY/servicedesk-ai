import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorNotice, LoadingBlock, Spinner } from '../components/ui';
import { ChannelBadge, PriorityBadge, SentimentBadge, StatusBadge } from '../components/TicketBits';
import AiPanel from '../components/AiPanel';
import { PRIORITY_OPTIONS, formatDateTime, humanise, initials, timeAgo } from '../lib/format';
import type { Category, Ticket, TicketEvent, TicketMessage, User } from '../lib/types';

/**
 * One ticket page serves all three roles.
 *
 * The customer sees the conversation; staff additionally see the triage
 * controls, internal notes and the AI panel. The server enforces all of this
 * independently — this component only decides what to draw.
 */
export default function TicketDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const [reply, setReply] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [aiAssisted, setAiAssisted] = useState(false);
  const [actionError, setActionError] = useState('');

  const isStaff = user?.role === 'AGENT' || user?.role === 'ADMIN';

  const ticketQuery = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api.get<Ticket>(`/tickets/${id}`),
  });

  const messagesQuery = useQuery({
    queryKey: ['ticket', id, 'messages'],
    queryFn: () => api.get<TicketMessage[]>(`/tickets/${id}/messages`),
  });

  const eventsQuery = useQuery({
    queryKey: ['ticket', id, 'events'],
    queryFn: () => api.get<TicketEvent[]>(`/tickets/${id}/events`),
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<User[]>('/users/agents'),
    enabled: isStaff,
  });

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['ticket', id] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
  };

  const sendReply = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/messages`, {
        body: reply.trim(),
        isInternalNote,
        aiAssisted,
      }),
    onSuccess: () => {
      setReply('');
      setIsInternalNote(false);
      setAiAssisted(false);
      setActionError('');
      refreshAll();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Could not send the reply.'),
  });

  const changeStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/tickets/${id}/status`, { status }),
    onSuccess: () => {
      setActionError('');
      refreshAll();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Could not update the status.'),
  });

  const updateTicket = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.patch(`/tickets/${id}`, payload),
    onSuccess: () => {
      setActionError('');
      refreshAll();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Could not update the ticket.'),
  });

  const assign = useMutation({
    mutationFn: (agentId: string | null) => api.patch(`/tickets/${id}/assign`, { agentId }),
    onSuccess: () => {
      setActionError('');
      refreshAll();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Could not assign the ticket.'),
  });

  // Clear any stale error when navigating between tickets.
  useEffect(() => setActionError(''), [id]);

  if (ticketQuery.isLoading) return <LoadingBlock />;
  if (ticketQuery.isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorNotice message={(ticketQuery.error as Error).message} />
        <Link to="/tickets" className="btn-secondary mt-4">
          Back to tickets
        </Link>
      </div>
    );
  }

  const ticket = ticketQuery.data!.data;
  const messages = messagesQuery.data?.data ?? [];
  const events = eventsQuery.data?.data ?? [];

  /**
   * Which statuses this user may move to. The same table exists on the server
   * and is authoritative; this is only to avoid offering an action that would
   * be rejected.
   */
  const nextStatuses: Record<string, string[]> = {
    NEW: isStaff ? ['OPEN', 'IN_PROGRESS', 'CLOSED'] : [],
    OPEN: isStaff ? ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'] : [],
    IN_PROGRESS: isStaff ? ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'] : [],
    WAITING_FOR_CUSTOMER: isStaff ? ['IN_PROGRESS', 'RESOLVED', 'CLOSED'] : [],
    RESOLVED: isStaff ? ['CLOSED', 'OPEN'] : ['CLOSED', 'OPEN'],
    CLOSED: user?.role === 'ADMIN' ? ['OPEN'] : [],
  };
  const available = nextStatuses[ticket.status] ?? [];

  const useDraft = (draft: string) => {
    setReply(draft);
    setAiAssisted(true);
    replyRef.current?.focus();
  };

  return (
    <div>
      <Link to={isStaff ? '/agent/queue' : '/tickets'} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-brand-600">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to tickets
      </Link>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-brand-600">{ticket.reference}</span>
            <span className="text-sm text-slate-400">·</span>
            <span className="text-sm text-slate-500">{timeAgo(ticket.createdAt)}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-ink">{ticket.subject}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ChannelBadge channel={ticket.channel} />
          <SentimentBadge sentiment={ticket.sentiment} />
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={ticket.status} />
        </div>
      </div>

      {actionError && (
        <div className="mb-5">
          <ErrorNotice message={actionError} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Conversation */}
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">
                {initials(ticket.customer.name)}
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">{ticket.customer.name}</p>
                <p className="text-xs text-slate-500">{formatDateTime(ticket.createdAt)}</p>
              </div>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
              {ticket.description}
            </p>
          </Card>

          {messages.map((message) => (
            <Card
              key={message.id}
              className={`p-5 ${message.isInternalNote ? 'border-amber-200 bg-amber-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white ${
                      message.author.role === 'CUSTOMER' ? 'bg-brand-500' : 'bg-ink'
                    }`}
                  >
                    {initials(message.author.name)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {message.author.name ?? 'You'}{' '}
                      <span className="font-normal text-slate-500">
                        · {humanise(message.author.role)}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500">{formatDateTime(message.createdAt)}</p>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <ChannelBadge channel={message.channel} />
                  {message.isInternalNote && (
                    <span className="badge bg-amber-200 text-amber-900">Internal note</span>
                  )}
                  {message.aiAssisted && (
                    <span className="badge bg-brand-100 text-brand-700">AI-assisted</span>
                  )}
                </div>
              </div>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                {message.body}
              </p>
            </Card>
          ))}

          {/* Reply box */}
          {ticket.status !== 'CLOSED' ? (
            <Card className="p-5">
              <label htmlFor="reply" className="label">
                {isInternalNote ? 'Internal note' : 'Your reply'}
              </label>
              <textarea
                id="reply"
                ref={replyRef}
                className="input min-h-32 resize-y"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={
                  isInternalNote
                    ? 'Visible to agents and admins only.'
                    : 'Type your message to the customer…'
                }
              />

              {ticket.channel === 'WHATSAPP' && !isInternalNote && (
                <p className="mt-2 text-xs font-medium text-[#0B7A3E]">
                  This customer is on WhatsApp. Your reply is delivered to their chat as plain
                  text — formatting and links are converted automatically.
                </p>
              )}

              {aiAssisted && !isInternalNote && (
                <p className="mt-2 text-xs font-medium text-brand-700">
                  This started from an AI draft. Edit it in your own words before sending.
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => sendReply.mutate()}
                  disabled={sendReply.isPending || reply.trim().length === 0}
                >
                  {sendReply.isPending ? (
                    <>
                      <Spinner className="h-4 w-4" /> Sending…
                    </>
                  ) : isInternalNote ? (
                    'Save note'
                  ) : (
                    'Send reply'
                  )}
                </button>

                {isStaff && (
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                      checked={isInternalNote}
                      onChange={(event) => setIsInternalNote(event.target.checked)}
                    />
                    Internal note (not visible to the customer)
                  </label>
                )}
              </div>
            </Card>
          ) : (
            <Card className="p-5 text-center text-sm text-slate-500">
              This ticket is closed.
              {user?.role === 'ADMIN' && ' Reopen it to continue the conversation.'}
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card className="p-5">
            <h3 className="font-semibold text-ink">Details</h3>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Customer</dt>
                <dd className="text-right font-medium text-ink">{ticket.customer.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Assigned to</dt>
                <dd className="text-right font-medium text-ink">
                  {ticket.agent?.name ?? 'Unassigned'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Category</dt>
                <dd className="text-right font-medium text-ink">{ticket.category?.name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Created</dt>
                <dd className="text-right font-medium text-ink">{formatDateTime(ticket.createdAt)}</dd>
              </div>
              {ticket.resolvedAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Resolved</dt>
                  <dd className="text-right font-medium text-ink">
                    {formatDateTime(ticket.resolvedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          {/* Triage controls — staff only */}
          {isStaff && (
            <Card className="p-5">
              <h3 className="font-semibold text-ink">Manage</h3>

              <div className="mt-4 space-y-4">
                <div>
                  <label htmlFor="assign" className="label">
                    Assign to
                  </label>
                  <select
                    id="assign"
                    className="input"
                    value={ticket.agent?.id ?? ''}
                    onChange={(event) => assign.mutate(event.target.value || null)}
                    disabled={assign.isPending}
                  >
                    <option value="">Unassigned</option>
                    {agents?.data.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.fullName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="priority" className="label">
                    Priority
                  </label>
                  <select
                    id="priority"
                    className="input"
                    value={ticket.priority}
                    onChange={(event) => updateTicket.mutate({ priority: event.target.value })}
                    disabled={updateTicket.isPending}
                  >
                    {PRIORITY_OPTIONS.map((priority) => (
                      <option key={priority} value={priority}>
                        {humanise(priority)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="category" className="label">
                    Category
                  </label>
                  <select
                    id="category"
                    className="input"
                    value={ticket.category?.id ?? ''}
                    onChange={(event) =>
                      updateTicket.mutate({ categoryId: event.target.value || null })
                    }
                    disabled={updateTicket.isPending}
                  >
                    <option value="">Uncategorised</option>
                    {categories?.data.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Card>
          )}

          {/* Status actions — offered to whoever the lifecycle permits */}
          {available.length > 0 && (
            <Card className="p-5">
              <h3 className="font-semibold text-ink">Change status</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {available.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="btn-secondary px-3 py-2 text-xs"
                    onClick={() => changeStatus.mutate(status)}
                    disabled={changeStatus.isPending}
                  >
                    {humanise(status)}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {isStaff && <AiPanel ticket={ticket} onUseDraft={useDraft} />}

          <Card className="p-5">
            <h3 className="font-semibold text-ink">Timeline</h3>
            <ol className="mt-4 space-y-3">
              {events.map((event) => (
                <li key={event.id} className="flex gap-3 text-sm">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-400" />
                  <div className="min-w-0">
                    <p className="text-slate-700">
                      <span className="font-medium">{humanise(event.type)}</span>
                      {event.from && event.to && (
                        <>
                          {' '}
                          <span className="text-slate-500">
                            {humanise(event.from)} → {humanise(event.to)}
                          </span>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-slate-400">
                      {event.actor ?? 'System'} · {timeAgo(event.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
