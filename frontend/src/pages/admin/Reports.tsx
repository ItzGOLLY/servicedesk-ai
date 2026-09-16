import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, getAccessToken, resolveApiBase } from '../../lib/api';
import { Card, ErrorNotice, LoadingBlock, PageHeader } from '../../components/ui';
import { formatHours, humanise } from '../../lib/format';
import type { LabelCount } from '../../lib/types';

interface WorkloadRow {
  name: string;
  email: string;
  open: number;
  resolved: number;
  averageResolutionHours: number | null;
}

interface TrendPoint {
  day: string;
  created: number;
  resolved: number;
}

interface ResolutionRow {
  label: string;
  averageResolutionHours: number | null;
  resolvedCount: number;
}

export default function Reports() {
  const status = useQuery({
    queryKey: ['reports', 'status'],
    queryFn: () => api.get<LabelCount[]>('/reports/tickets-by-status'),
  });
  const category = useQuery({
    queryKey: ['reports', 'category'],
    queryFn: () => api.get<LabelCount[]>('/reports/tickets-by-category'),
  });
  const workload = useQuery({
    queryKey: ['reports', 'workload'],
    queryFn: () => api.get<WorkloadRow[]>('/reports/agent-workload'),
  });
  const trends = useQuery({
    queryKey: ['reports', 'trends'],
    queryFn: () => api.get<TrendPoint[]>('/reports/trends?days=30'),
  });
  const resolution = useQuery({
    queryKey: ['reports', 'resolution'],
    queryFn: () => api.get<ResolutionRow[]>('/reports/resolution-time'),
  });

  const queries = [status, category, workload, trends, resolution];
  const loading = queries.some((q) => q.isLoading);
  const failed = queries.find((q) => q.isError);

  /**
   * The export endpoint returns a file, not JSON, and needs the bearer token —
   * so it is fetched and turned into a blob rather than opened as a plain link.
   */
  const downloadCsv = async () => {
    const base = resolveApiBase(import.meta.env.VITE_API_BASE_URL);
    const response = await fetch(`${base}/reports/export?format=csv`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
    });
    if (!response.ok) return;

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'servicedesk-tickets.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <LoadingBlock />;
  if (failed) return <ErrorNotice message={(failed.error as Error).message} />;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Aggregated from the cloud database at the moment you open this page."
        action={
          <button type="button" className="btn-secondary" onClick={() => void downloadCsv()}>
            Export CSV
          </button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-semibold text-ink">Created vs resolved</h2>
          <p className="mt-0.5 text-xs text-slate-500">Last 30 days</p>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trends.data!.data} margin={{ left: -18, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} stroke="#E2E8F0" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  tickFormatter={(value: string) => value.slice(5)}
                  interval="preserveStartEnd"
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip />
                <Legend />
                <Line isAnimationActive={false} type="monotone" dataKey="created" stroke="#028090" strokeWidth={2} name="Created" dot={false} />
                <Line isAnimationActive={false} type="monotone" dataKey="resolved" stroke="#02C39A" strokeWidth={2} name="Resolved" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-ink">Tickets by status</h2>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={status.data!.data} margin={{ left: -18, right: 8 }}>
                <CartesianGrid vertical={false} stroke="#E2E8F0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#64748B' }}
                  tickFormatter={(value: string) => humanise(value)}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip cursor={{ fill: '#F1F5F9' }} />
                <Bar isAnimationActive={false} dataKey="count" fill="#028090" radius={[4, 4, 0, 0]} name="Tickets" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-ink">Tickets by category</h2>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={category.data!.data} layout="vertical" margin={{ left: 12, right: 16 }}>
                <CartesianGrid horizontal={false} stroke="#E2E8F0" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis type="category" dataKey="label" width={100} tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip cursor={{ fill: '#F1F5F9' }} />
                <Bar isAnimationActive={false} dataKey="count" fill="#00A896" radius={[0, 4, 4, 0]} name="Tickets" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-ink">Average resolution time</h2>
          <p className="mt-0.5 text-xs text-slate-500">By category, resolved tickets only</p>
          {resolution.data!.data.length === 0 ? (
            <p className="py-16 text-center text-sm text-slate-500">
              No tickets have been resolved yet.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-semibold">Category</th>
                    <th className="pb-2 text-right font-semibold">Resolved</th>
                    <th className="pb-2 text-right font-semibold">Average</th>
                  </tr>
                </thead>
                <tbody>
                  {resolution.data!.data.map((row) => (
                    <tr key={row.label} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 font-medium text-ink">{row.label}</td>
                      <td className="py-2.5 text-right text-slate-600">{row.resolvedCount}</td>
                      <td className="py-2.5 text-right text-slate-600">
                        {formatHours(row.averageResolutionHours)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="font-semibold text-ink">Agent workload</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-semibold">Agent</th>
                <th className="pb-2 font-semibold">Email</th>
                <th className="pb-2 text-right font-semibold">Open</th>
                <th className="pb-2 text-right font-semibold">Resolved</th>
                <th className="pb-2 text-right font-semibold">Avg resolution</th>
              </tr>
            </thead>
            <tbody>
              {workload.data!.data.map((agent) => (
                <tr key={agent.email} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 font-medium text-ink">{agent.name}</td>
                  <td className="py-2.5 text-slate-600">{agent.email}</td>
                  <td className="py-2.5 text-right text-slate-600">{agent.open}</td>
                  <td className="py-2.5 text-right text-slate-600">{agent.resolved}</td>
                  <td className="py-2.5 text-right text-slate-600">
                    {formatHours(agent.averageResolutionHours)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
