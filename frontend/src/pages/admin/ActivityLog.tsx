import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
} from '../../components/ui';
import { formatDateTime, humanise } from '../../lib/format';
import type { AuditLog } from '../../lib/types';

/** Actions that change access or destroy data are highlighted. */
const SENSITIVE = new Set([
  'USER_ROLE_CHANGED',
  'USER_DEACTIVATED',
  'TICKET_DELETED',
  'CATEGORY_DELETED',
]);

export default function ActivityLog() {
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['audit-logs', entityType, page],
    queryFn: () => api.get<AuditLog[]>(`/audit-logs${queryString({ entityType, page, limit: 25 })}`),
  });

  const logs = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div>
      <PageHeader
        title="Activity log"
        subtitle="Who changed what, and when. Every privileged action is recorded."
      />

      <Card className="mb-5 p-4">
        <select
          className="input sm:max-w-xs"
          value={entityType}
          onChange={(event) => {
            setEntityType(event.target.value);
            setPage(1);
          }}
          aria-label="Filter by entity type"
        >
          <option value="">All activity</option>
          <option value="ticket">Tickets</option>
          <option value="user">Users</option>
          <option value="category">Categories</option>
        </select>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : isError ? (
          <div className="p-4">
            <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            title="No activity recorded"
            message="Privileged actions such as role changes and deletions will appear here."
          />
        ) : (
          <>
            <ul>
              {logs.map((log) => (
                <li
                  key={log.id}
                  className="flex gap-4 border-b border-slate-100 px-5 py-4 last:border-0"
                >
                  <div
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      SENSITIVE.has(log.action) ? 'bg-rose-500' : 'bg-brand-400'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className="font-medium text-ink">{humanise(log.action)}</p>
                      <span className="badge bg-slate-100 text-slate-600">{log.entityType}</span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {log.actor ? `${log.actor.name} (${log.actor.email})` : 'System'}
                      {' · '}
                      {formatDateTime(log.createdAt)}
                      {log.ipAddress && ` · ${log.ipAddress}`}
                    </p>
                    {Object.keys(log.metadata ?? {}).length > 0 && (
                      <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
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
  );
}
