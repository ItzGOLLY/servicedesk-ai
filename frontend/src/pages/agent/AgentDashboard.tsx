import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { Card, EmptyState, ErrorNotice, LoadingBlock, PageHeader, StatTile } from '../../components/ui';
import { PriorityBadge, StatusBadge } from '../../components/TicketBits';
import { formatHours, timeAgo } from '../../lib/format';
import type { AgentDashboard as DashboardData } from '../../lib/types';

export default function AgentDashboard() {
  const { user } = useAuth();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', 'agent'],
    queryFn: () => api.get<DashboardData>('/dashboard/agent'),
  });

  if (isLoading) return <LoadingBlock />;
  if (isError) {
    return <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />;
  }

  const { metrics, byCategory, queue } = data!.data;

  return (
    <div>
      <PageHeader
        title={`Good day, ${user?.fullName.split(' ')[0]}`}
        subtitle="Your assigned work and where the queue stands."
        action={
          <Link to="/agent/queue" className="btn-primary">
            Open ticket queue
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Assigned to you" value={metrics.assigned} />
        <StatTile label="Still open" value={metrics.open} accent="text-blue-600" />
        <StatTile label="High priority" value={metrics.highPriority} accent="text-rose-600" />
        <StatTile label="Resolved" value={metrics.resolved} accent="text-emerald-600" />
        <StatTile
          label="Avg resolution"
          value={formatHours(metrics.averageResolutionHours)}
          accent="text-ink"
          hint={metrics.averageResolutionHours === null ? 'No resolved tickets yet' : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="font-semibold text-ink">Your open queue</h2>
            {metrics.unassignedInQueue > 0 && (
              <Link
                to="/agent/queue?agentId=unassigned"
                className="text-sm font-semibold text-brand-600 hover:underline"
              >
                {metrics.unassignedInQueue} unassigned
              </Link>
            )}
          </div>

          {queue.length === 0 ? (
            <EmptyState
              title="Nothing assigned to you"
              message="When a ticket is assigned to you it will appear here, sorted by priority."
              action={
                <Link to="/agent/queue" className="btn-secondary">
                  Browse the full queue
                </Link>
              }
            />
          ) : (
            <ul>
              {queue.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 transition last:border-0 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-brand-600">{ticket.reference}</span>
                        <span className="text-sm text-slate-500">· {ticket.customerName}</span>
                      </div>
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

        <Card className="p-5 lg:col-span-2">
          <h2 className="font-semibold text-ink">Your tickets by category</h2>
          {byCategory.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">
              No data yet — this chart fills in as you work on tickets.
            </p>
          ) : (
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byCategory} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} stroke="#E2E8F0" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: '#64748B' }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={90}
                    tick={{ fontSize: 12, fill: '#64748B' }}
                  />
                  <Tooltip cursor={{ fill: '#F1F5F9' }} />
                  <Bar isAnimationActive={false} dataKey="count" fill="#028090" radius={[0, 4, 4, 0]} name="Tickets" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
