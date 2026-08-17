import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { Card, EmptyState, ErrorNotice, LoadingBlock, PageHeader, StatTile } from '../../components/ui';
import { PriorityBadge, StatusBadge } from '../../components/TicketBits';
import { timeAgo } from '../../lib/format';
import type { CustomerDashboard as DashboardData } from '../../lib/types';

export default function CustomerDashboard() {
  const { user } = useAuth();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', 'customer'],
    queryFn: () => api.get<DashboardData>('/dashboard/customer'),
  });

  if (isLoading) return <LoadingBlock />;
  if (isError) {
    return <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />;
  }

  const { metrics, recentTickets } = data!.data;

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user?.fullName.split(' ')[0]}`}
        subtitle="Track your support requests and their progress."
        action={
          <Link to="/tickets/new" className="btn-primary">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            New ticket
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total tickets" value={metrics.total} />
        <StatTile label="Open" value={metrics.open} accent="text-blue-600" />
        <StatTile label="Resolved" value={metrics.resolved} accent="text-emerald-600" />
        <StatTile
          label="Awaiting your reply"
          value={metrics.awaitingYourReply}
          accent="text-amber-600"
          hint={metrics.awaitingYourReply > 0 ? 'An agent is waiting on you' : undefined}
        />
      </div>

      <Card className="mt-6">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-ink">Recent tickets</h2>
          <Link to="/tickets" className="text-sm font-semibold text-brand-600 hover:underline">
            View all
          </Link>
        </div>

        {recentTickets.length === 0 ? (
          <EmptyState
            title="No tickets yet"
            message="When you raise a support request it will appear here with its reference and status."
            action={
              <Link to="/tickets/new" className="btn-primary">
                Raise your first ticket
              </Link>
            }
          />
        ) : (
          <ul>
            {recentTickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  to={`/tickets/${ticket.id}`}
                  className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 transition last:border-0 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-bold text-brand-600">{ticket.reference}</span>
                    <p className="mt-0.5 truncate font-medium text-ink">{ticket.subject}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{timeAgo(ticket.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={ticket.priority} />
                    <StatusBadge status={ticket.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
