import { Link } from 'react-router-dom';
import { Badge } from './ui';
import {
  PRIORITY_STYLES,
  SENTIMENT_STYLES,
  STATUS_STYLES,
  humanise,
  timeAgo,
} from '../lib/format';
import type { Ticket, TicketPriority, TicketSentiment, TicketStatus } from '../lib/types';

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <Badge className={STATUS_STYLES[status]}>{humanise(status)}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge className={PRIORITY_STYLES[priority]}>{humanise(priority)}</Badge>;
}

export function SentimentBadge({ sentiment }: { sentiment: TicketSentiment | null }) {
  if (!sentiment) return null;
  return <Badge className={SENTIMENT_STYLES[sentiment]}>{humanise(sentiment)}</Badge>;
}

/**
 * One ticket row, used by every list in the product.
 *
 * On mobile the table layout collapses into this stacked card, which is how the
 * queue stays usable on a phone without a second implementation.
 */
export function TicketRow({ ticket, showCustomer = false }: { ticket: Ticket; showCustomer?: boolean }) {
  return (
    <Link
      to={`/tickets/${ticket.id}`}
      className="block border-b border-slate-100 px-4 py-4 transition last:border-0 hover:bg-slate-50"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-brand-600">{ticket.reference}</span>
            {showCustomer && (
              <span className="text-sm text-slate-500">· {ticket.customer.name}</span>
            )}
          </div>
          <p className="mt-1 truncate font-semibold text-ink">{ticket.subject}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{timeAgo(ticket.createdAt)}</span>
            {ticket.category?.name && <span>· {ticket.category.name}</span>}
            <span>· {ticket.agent?.name ? `Assigned to ${ticket.agent.name}` : 'Unassigned'}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <SentimentBadge sentiment={ticket.sentiment} />
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={ticket.status} />
        </div>
      </div>
    </Link>
  );
}
