import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, PageHeader, Badge, LoadingBlock, ErrorNotice, EmptyState, Pagination } from '../../components/ui';

/**
 * The developer page: API keys and outbound webhooks.
 *
 * This is the half of the product that makes it an integration platform — a
 * tenant's own software talks to us here, exactly as it would to Twilio.
 *
 * Both secrets on this page are shown once and never again, because only
 * their hashes are stored. The UI says so at the moment of issue rather than
 * leaving the user to discover it.
 */

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Endpoint {
  id: string;
  url: string;
  is_active: boolean;
  events: string[];
  created_at: string;
}

interface Delivery {
  id: string;
  event_type: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

const deliveryTone: Record<Delivery['status'], string> = {
  DELIVERED: 'bg-emerald-100 text-emerald-800',
  PENDING: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

/** Shown once, with an explicit warning, then gone. */
function SecretReveal({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">{label}</p>
      <p className="mt-1 text-xs text-amber-800">
        Copy it now. Only a hash is stored, so it cannot be shown again.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-xs text-slate-800">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
          className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-amber-300 px-3 py-2 text-xs text-amber-900"
        >
          Done
        </button>
      </div>
    </div>
  );
}

export default function Developer() {
  const queryClient = useQueryClient();
  const [keyName, setKeyName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [revealed, setRevealed] = useState<{ label: string; value: string } | null>(null);
  const [page, setPage] = useState(1);

  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<ApiKey[]>('/platform/api-keys').then((r) => r.data),
  });

  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => api.get<Endpoint[]>('/platform/webhook-endpoints').then((r) => r.data),
  });

  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', page],
    queryFn: () =>
      api.get<Delivery[]>(`/platform/webhook-deliveries?page=${page}&limit=10`),
  });

  const createKey = useMutation({
    mutationFn: (name: string) => api.post<{ key: string }>('/platform/api-keys', { name }),
    onSuccess: (response) => {
      setRevealed({ label: 'Your new API key', value: response.data.key });
      setKeyName('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api.delete(`/platform/api-keys/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  const createEndpoint = useMutation({
    mutationFn: (url: string) =>
      api.post<{ secret: string }>('/platform/webhook-endpoints', {
        url,
        events: ['message.received', 'message.status'],
      }),
    onSuccess: (response) => {
      setRevealed({ label: 'Your webhook signing secret', value: response.data.secret });
      setEndpointUrl('');
      void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    },
  });

  const removeEndpoint = useMutation({
    mutationFn: (id: string) => api.delete(`/platform/webhook-endpoints/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] }),
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post('/platform/webhook-deliveries/retry'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] }),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Developers"
        subtitle="API keys for sending messages programmatically, and webhooks for receiving them."
      />

      {revealed && (
        <SecretReveal
          label={revealed.label}
          value={revealed.value}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {/* --- API keys --- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">API keys</h3>

        <Card>
          <form
            className="flex flex-col gap-3 p-4 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (keyName.trim()) createKey.mutate(keyName.trim());
            }}
          >
            <input
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="Key name, e.g. Production server"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              maxLength={60}
            />
            <button
              type="submit"
              disabled={!keyName.trim() || createKey.isPending}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {createKey.isPending ? 'Creating…' : 'Create key'}
            </button>
          </form>
        </Card>

        {keys.isLoading ? (
          <LoadingBlock />
        ) : (keys.data ?? []).length === 0 ? (
          <EmptyState title="No API keys" message="Create one to call the API from your own code." />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Key</th>
                    <th className="px-4 py-3">Last used</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {keys.data!.map((key) => (
                    <tr key={key.id} className={key.revoked_at ? 'opacity-50' : ''}>
                      <td className="px-4 py-3 font-medium text-slate-900">{key.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{key.prefix}…</td>
                      <td className="px-4 py-3 text-slate-600">
                        {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'never'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {key.revoked_at ? (
                          <Badge className="bg-slate-200 text-slate-700">revoked</Badge>
                        ) : (
                          <button
                            type="button"
                            onClick={() => revokeKey.mutate(key.id)}
                            className="text-sm text-rose-700 hover:underline"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* --- webhooks --- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Webhook endpoints
        </h3>

        <Card>
          <form
            className="flex flex-col gap-3 p-4 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (endpointUrl.trim()) createEndpoint.mutate(endpointUrl.trim());
            }}
          >
            <input
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://your-app.example.com/webhooks/whatsapp"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!endpointUrl.trim() || createEndpoint.isPending}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {createEndpoint.isPending ? 'Adding…' : 'Add endpoint'}
            </button>
          </form>
          {createEndpoint.error && (
            <div className="px-4 pb-4">
              <ErrorNotice message={(createEndpoint.error as Error).message} />
            </div>
          )}
        </Card>

        {(endpoints.data ?? []).length > 0 && (
          <Card>
            <ul className="divide-y divide-slate-100">
              {endpoints.data!.map((endpoint) => (
                <li key={endpoint.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-slate-800">{endpoint.url}</p>
                    <p className="text-xs text-slate-500">{endpoint.events.join(' · ')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeEndpoint.mutate(endpoint.id)}
                    className="shrink-0 text-sm text-rose-700 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <p className="font-medium text-slate-900">Verifying a delivery</p>
          <p className="mt-1 text-slate-600">
            Each request carries <code className="rounded bg-white px-1">X-ServiceDesk-Signature:
            t=&lt;timestamp&gt;,v1=&lt;hmac&gt;</code>. Recompute it as{' '}
            <code className="rounded bg-white px-1">HMAC-SHA256(secret, "&lt;timestamp&gt;." + rawBody)</code>{' '}
            and compare in constant time. Reject anything older than five minutes — the timestamp is
            signed, so a captured request cannot be replayed.
          </p>
        </div>
      </section>

      {/* --- delivery log --- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent deliveries
          </h3>
          <button
            type="button"
            onClick={() => retryFailed.mutate()}
            disabled={retryFailed.isPending}
            className="text-sm text-teal-700 hover:underline disabled:opacity-60"
          >
            {retryFailed.isPending ? 'Retrying…' : 'Retry failed'}
          </button>
        </div>

        {deliveries.isLoading ? (
          <LoadingBlock />
        ) : (deliveries.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="Nothing delivered yet"
            message="Events appear here once an endpoint is configured and a message arrives."
          />
        ) : (
          <>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Event</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Attempts</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {deliveries.data!.data.map((delivery) => (
                      <tr key={delivery.id}>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">
                          {delivery.event_type}
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={deliveryTone[delivery.status]}>{delivery.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{delivery.attempts}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {delivery.response_status ?? '—'}
                          {delivery.last_error && (
                            <span className="block text-rose-700">{delivery.last_error}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">
                          {new Date(delivery.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {deliveries.data?.meta && (
              <Pagination
                page={deliveries.data.meta.page}
                totalPages={deliveries.data.meta.totalPages}
                total={deliveries.data.meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
