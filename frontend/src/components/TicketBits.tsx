import { Link } from 'react-router-dom';
import { Badge } from './ui';
import {
  PRIORITY_STYLES,
  SENTIMENT_STYLES,
  STATUS_STYLES,
  humanise,
  timeAgo,
} from '../lib/format';
import type { Ticket, TicketChannel, TicketPriority, TicketSentiment, TicketStatus } from '../lib/types';

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
 * Marks a ticket or message that came in over WhatsApp.
 *
 * Only WhatsApp is labelled: the web is the default channel, so badging it too
 * would add noise to every row without telling an agent anything.
 */
export function ChannelBadge({ channel }: { channel: TicketChannel }) {
  if (channel !== 'WHATSAPP') return null;
  return (
    <Badge className="bg-[#25D366]/15 text-[#0B7A3E]">
      <svg className="mr-1 h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12.04 2A9.9 9.9 0 002.1 11.9a9.8 9.8 0 001.34 4.96L2 22l5.28-1.38a9.9 9.9 0 004.76 1.21h.01a9.9 9.9 0 009.94-9.9A9.9 9.9 0 0012.04 2zm5.8 14.06c-.24.68-1.4 1.3-1.94 1.34-.5.05-.98.23-3.3-.69-2.77-1.1-4.53-3.94-4.67-4.13-.13-.19-1.11-1.48-1.11-2.82 0-1.34.7-2 .95-2.27a1 1 0 01.72-.34h.52c.16 0 .39-.06.6.46l.83 2c.07.14.11.3.02.48l-.31.5-.45.5c-.14.14-.29.3-.12.58.16.28.72 1.19 1.55 1.93 1.06.95 1.96 1.24 2.24 1.38.28.14.44.12.6-.07l.87-1c.2-.24.36-.18.6-.1l1.72.82c.25.12.41.18.47.28.06.1.06.58-.18 1.25z" />
      </svg>
      WhatsApp
    </Badge>
  );
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
          <ChannelBadge channel={ticket.channel} />
          <SentimentBadge sentiment={ticket.sentiment} />
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={ticket.status} />
        </div>
      </div>
    </Link>
  );
}
