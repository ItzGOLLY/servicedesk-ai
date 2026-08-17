import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../../lib/api';
import { Card, ErrorNotice, LoadingBlock, PageHeader, StatTile } from '../../components/ui';
import { formatHours, humanise } from '../../lib/format';
import type { AdminDashboard as DashboardData } from '../../lib/types';

/**
 * Every chart here is bound to a live API response. There are no placeholder
 * series and no hard-coded numbers anywhere in this file.
 */

const SENTIMENT_COLOURS: Record<string, string> = {
  POSITIVE: '#02C39A',
  NEUTRAL: '#94A3B8',
  NEGATIVE: '#F43F5E',
  UNCLASSIFIED: '#CBD5E1',
};

const PRIORITY_COLOURS: Record<string, string> = {
  LOW: '#94A3B8',
  MEDIUM: '#38BDF8',
  HIGH: '#FB923C',
  URGENT: '#F43F5E',
};

function ChartCard({
  title,
  subtitle,
  children,
  empty,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold text-ink">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      {empty ? (
        <p className="py-12 text-center text-sm text-slate-500">
          No data yet. This chart fills in as tickets are raised.
        </p>
      ) : (
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

export default function AdminDashboard() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', 'admin'],
    queryFn: () => api.get<DashboardData>('/dashboard/admin'),
  });

  if (isLoading) return <LoadingBlock />;
  if (isError) {
    return <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />;
  }

  const { metrics, byStatus, byPriority, byCategory, bySentiment, agentWorkload, trend, ai } =
    data!.data;

  const totalTickets = metrics.totalTickets;

  return (
    <div>
      <PageHeader
        title="Admin overview"
        subtitle="Live figures computed from the cloud database on every request."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total tickets" value={totalTickets} />
        <StatTile label="Open" value={metrics.openTickets} accent="text-blue-600" />
        <StatTile label="Resolved" value={metrics.resolvedTickets} accent="text-emerald-600" />
        <StatTile
          label="Avg resolution"
          value={formatHours(metrics.averageResolutionHours)}
          accent="text-ink"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Unassigned"
          value={metrics.unassignedTickets}
          accent={metrics.unassignedTickets > 0 ? 'text-amber-600' : 'text-slate-400'}
          hint={metrics.unassignedTickets > 0 ? 'Waiting for an owner' : 'Queue fully assigned'}
        />
        <StatTile label="Active customers" value={metrics.activeCustomers} accent="text-ink" />
        <StatTile label="Active agents" value={metrics.activeAgents} accent="text-ink" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Ticket volume"
          subtitle="Tickets raised over the last 30 days"
          empty={trend.every((point) => point.count === 0)}
        >
          <AreaChart data={trend} margin={{ left: -18, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="volume" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#028090" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#028090" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#E2E8F0" />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: '#64748B' }}
              tickFormatter={(value: string) => value.slice(5)}
              interval="preserveStartEnd"
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
            <Tooltip />
            <Area isAnimationActive={false}
              type="monotone"
              dataKey="count"
              stroke="#028090"
              strokeWidth={2}
              fill="url(#volume)"
              name="Tickets"
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Tickets by category" empty={byCategory.length === 0}>
          <BarChart data={byCategory} layout="vertical" margin={{ left: 12, right: 16 }}>
            <CartesianGrid horizontal={false} stroke="#E2E8F0" />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
            <YAxis type="category" dataKey="label" width={100} tick={{ fontSize: 11, fill: '#64748B' }} />
            <Tooltip cursor={{ fill: '#F1F5F9' }} />
            <Bar isAnimationActive={false} dataKey="count" fill="#00A896" radius={[0, 4, 4, 0]} name="Tickets" />
          </BarChart>
        </ChartCard>

        <ChartCard title="Sentiment distribution" empty={bySentiment.length === 0}>
          <PieChart>
            <Pie isAnimationActive={false}
              data={bySentiment}
              dataKey="count"
              nameKey="label"
              innerRadius={55}
              outerRadius={90}
              paddingAngle={2}
            >
              {bySentiment.map((entry) => (
                <Cell key={entry.label} fill={SENTIMENT_COLOURS[entry.label] ?? '#CBD5E1'} />
              ))}
            </Pie>
            <Tooltip />
            <Legend formatter={(value: string) => humanise(value)} />
          </PieChart>
        </ChartCard>

        <ChartCard title="Tickets by priority" empty={byPriority.length === 0}>
          <BarChart data={byPriority} margin={{ left: -18, right: 8 }}>
            <CartesianGrid vertical={false} stroke="#E2E8F0" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748B' }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
            <Tooltip cursor={{ fill: '#F1F5F9' }} />
            <Bar isAnimationActive={false} dataKey="count" radius={[4, 4, 0, 0]} name="Tickets">
              {byPriority.map((entry) => (
                <Cell key={entry.label} fill={PRIORITY_COLOURS[entry.label] ?? '#028090'} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-semibold text-ink">Agent workload</h2>
          {agentWorkload.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No agents yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-semibold">Agent</th>
                    <th className="pb-2 text-right font-semibold">Open</th>
                    <th className="pb-2 text-right font-semibold">Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {agentWorkload.map((agent) => (
                    <tr key={agent.name} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 font-medium text-ink">{agent.name}</td>
                      <td className="py-2.5 text-right text-slate-600">{agent.open}</td>
                      <td className="py-2.5 text-right text-slate-600">{agent.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="font-semibold text-ink">Status breakdown</h2>
            <ul className="mt-4 space-y-2.5">
              {byStatus.map((entry) => (
                <li key={entry.label} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 text-sm text-slate-600">
                    {humanise(entry.label)}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{
                        width: totalTickets ? `${(entry.count / totalTickets) * 100}%` : '0%',
                      }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-sm font-semibold text-ink">
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="font-semibold text-ink">AI assistance</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              How much the assistant is actually being used.
            </p>
            <dl className="mt-4 grid grid-cols-3 gap-4">
              <div>
                <dt className="text-xs text-slate-500">Classified</dt>
                <dd className="mt-1 text-2xl font-bold text-brand-600">{ai.ticketsClassified}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">AI-assisted replies</dt>
                <dd className="mt-1 text-2xl font-bold text-sea">{ai.aiAssistedReplies}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">From fallback</dt>
                <dd className="mt-1 text-2xl font-bold text-amber-600">
                  {ai.suggestionsFromFallback}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              Suggestions produced by the rule-based fallback are counted separately, so this figure
              stays honest when the AI provider is unavailable.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
