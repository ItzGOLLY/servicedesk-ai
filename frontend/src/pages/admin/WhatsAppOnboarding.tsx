import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, PageHeader, Badge, LoadingBlock, ErrorNotice, EmptyState } from '../../components/ui';

/**
 * Embedded Signup — the page that makes this a Tech Provider rather than an app.
 *
 * A business clicks one button, authorises inside Meta's own dialog, and their
 * WhatsApp number is serving traffic on this platform a few seconds later.
 * Everything that could grant access happens on the server: the browser only
 * ever handles a short-lived authorisation code, never a token.
 */

interface SignupConfig {
  app_id: string;
  config_id: string;
  graph_version: string;
  configured: boolean;
}

interface Connection {
  id: string;
  waba_id: string;
  business_name: string | null;
  status: 'PENDING' | 'ACTIVE' | 'ERROR' | 'DISCONNECTED';
  error_detail: string | null;
  token_fingerprint: string;
  subscribed_at: string | null;
  created_at: string;
}

interface TenantNumber {
  id: string;
  phone_number_id: string;
  display_number: string;
  verified_name: string | null;
  quality_rating: string | null;
  registered: boolean;
  is_default: boolean;
  connection_status: string;
}

/** What Meta's dialog posts back to the opener window. */
interface SignupResult {
  phone_number_id: string;
  waba_id: string;
}

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (callback: (response: FbLoginResponse) => void, options: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

interface FbLoginResponse {
  authResponse?: { code?: string };
  status?: string;
}

const statusTone: Record<Connection['status'], string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  PENDING: 'bg-amber-100 text-amber-800',
  ERROR: 'bg-rose-100 text-rose-800',
  DISCONNECTED: 'bg-slate-200 text-slate-700',
};

export default function WhatsAppOnboarding() {
  const queryClient = useQueryClient();
  const [sdkReady, setSdkReady] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Meta posts the result as a window message rather than returning it from
  // FB.login, so the two have to be correlated: the message carries the ids,
  // the callback carries the code.
  const signupResult = useRef<SignupResult | null>(null);

  const config = useQuery({
    queryKey: ['signup-config'],
    queryFn: () => api.get<SignupConfig>('/platform/signup-config').then((r) => r.data),
  });

  const connections = useQuery({
    queryKey: ['wa-connections'],
    queryFn: () => api.get<Connection[]>('/platform/connections').then((r) => r.data),
  });

  const numbers = useQuery({
    queryKey: ['wa-numbers'],
    queryFn: () => api.get<TenantNumber[]>('/platform/numbers').then((r) => r.data),
  });

  const complete = useMutation({
    mutationFn: (payload: { code: string; waba_id: string; phone_number_id: string }) =>
      api.post<{ numbers: unknown[]; warnings: string[] }>(
        '/platform/connections/embedded-signup',
        payload
      ),
    onSuccess: (response) => {
      const warnings = response.data.warnings ?? [];
      setNotice(
        warnings.length
          ? `Connected, with notes: ${warnings.join(' ')}`
          : 'WhatsApp account connected. Messages to this number now arrive here.'
      );
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: ['wa-connections'] });
      void queryClient.invalidateQueries({ queryKey: ['wa-numbers'] });
    },
    onError: (error: Error) => {
      setFailure(error.message);
      setNotice(null);
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/platform/connections/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wa-connections'] });
      void queryClient.invalidateQueries({ queryKey: ['wa-numbers'] });
    },
  });

  // --- load Meta's SDK ------------------------------------------------------
  useEffect(() => {
    if (!config.data?.configured) return;
    if (window.FB) {
      setSdkReady(true);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: config.data.app_id,
        cookie: true,
        xfbml: false,
        version: config.data.graph_version,
      });
      setSdkReady(true);
    };

    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);

    return () => {
      script.remove();
    };
  }, [config.data]);

  // --- listen for the dialog's result --------------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only Facebook may speak to this listener; without the origin check any
      // page could claim an onboarding finished.
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') {
        return;
      }

      try {
        const payload = JSON.parse(event.data as string) as {
          type?: string;
          event?: string;
          data?: { phone_number_id?: string; waba_id?: string };
        };

        if (payload.type !== 'WA_EMBEDDED_SIGNUP') return;

        if (payload.event === 'FINISH' || payload.event === 'FINISH_ONLY_WABA') {
          if (payload.data?.waba_id && payload.data?.phone_number_id) {
            signupResult.current = {
              waba_id: payload.data.waba_id,
              phone_number_id: payload.data.phone_number_id,
            };
          }
        } else if (payload.event === 'CANCEL') {
          setFailure('Onboarding was cancelled before it finished.');
          setLaunching(false);
        }
      } catch {
        // Facebook posts non-JSON messages on this channel too; ignoring them
        // is correct, not an error worth surfacing.
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const launch = () => {
    if (!window.FB || !config.data) return;

    setLaunching(true);
    setFailure(null);
    setNotice(null);
    signupResult.current = null;

    window.FB.login(
      (response: FbLoginResponse) => {
        const code = response.authResponse?.code;
        const result = signupResult.current;

        if (!code) {
          setFailure('Meta did not return an authorisation code. Nothing was connected.');
          setLaunching(false);
          return;
        }
        if (!result) {
          setFailure('Meta returned a code but no account details. Try the connection again.');
          setLaunching(false);
          return;
        }

        complete.mutate(
          { code, waba_id: result.waba_id, phone_number_id: result.phone_number_id },
          { onSettled: () => setLaunching(false) }
        );
      },
      {
        config_id: config.data.config_id,
        // Returns a code to exchange server-side rather than a browser token.
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      }
    );
  };

  if (config.isLoading) return <LoadingBlock label="Checking platform configuration…" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect WhatsApp"
        subtitle="Onboard a WhatsApp Business number through Meta. Messages to it arrive here within seconds."
      />

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {failure && <ErrorNotice message={failure} />}

      <Card>
        <div className="p-5">
          {!config.data?.configured ? (
            <div className="space-y-3">
              <h3 className="font-semibold text-slate-900">Not configured yet</h3>
              <p className="text-sm text-slate-600">
                This deployment has no Meta app credentials, so the onboarding dialog cannot be
                opened. An operator needs to set <code className="rounded bg-slate-100 px-1">META_APP_ID</code>,{' '}
                <code className="rounded bg-slate-100 px-1">META_APP_SECRET</code> and{' '}
                <code className="rounded bg-slate-100 px-1">META_ES_CONFIG_ID</code>.
              </p>
              <p className="text-sm text-slate-600">
                Until then, numbers can still be connected manually and everything else on this
                page works.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <h3 className="font-semibold text-slate-900">Add a WhatsApp number</h3>
                <p className="max-w-xl text-sm text-slate-600">
                  You will sign in to Meta, choose or create a WhatsApp Business account, and
                  authorise this platform to send and receive on your behalf. We never see your
                  Meta password, and the access token never reaches your browser.
                </p>
              </div>
              <button
                type="button"
                onClick={launch}
                disabled={!sdkReady || launching || complete.isPending}
                className="shrink-0 rounded-lg bg-[#1877F2] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#166FE5] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {launching || complete.isPending
                  ? 'Connecting…'
                  : sdkReady
                    ? 'Connect with Facebook'
                    : 'Loading Meta SDK…'}
              </button>
            </div>
          )}
        </div>
      </Card>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Connected accounts
        </h3>

        {connections.isLoading ? (
          <LoadingBlock />
        ) : connections.error ? (
          <ErrorNotice message="Could not load connections." onRetry={() => void connections.refetch()} />
        ) : (connections.data ?? []).length === 0 ? (
          <EmptyState
            title="No WhatsApp account connected"
            message="Connect one above to start receiving messages."
          />
        ) : (
          <div className="space-y-3">
            {connections.data!.map((connection) => (
              <Card key={connection.id}>
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {connection.business_name ?? 'WhatsApp Business account'}
                      </span>
                      <Badge className={statusTone[connection.status]}>{connection.status}</Badge>
                    </div>
                    <p className="font-mono text-xs text-slate-500">
                      Account {connection.waba_id} · token {connection.token_fingerprint}
                    </p>
                    {connection.subscribed_at ? (
                      <p className="text-xs text-emerald-700">
                        Subscribed to webhooks — inbound messages are being delivered.
                      </p>
                    ) : (
                      <p className="text-xs text-amber-700">
                        Not subscribed to webhooks yet; nothing will arrive until it is.
                      </p>
                    )}
                    {connection.error_detail && (
                      <p className="max-w-2xl text-xs text-rose-700">{connection.error_detail}</p>
                    )}
                  </div>

                  {connection.status !== 'DISCONNECTED' && (
                    <button
                      type="button"
                      onClick={() => disconnect.mutate(connection.id)}
                      disabled={disconnect.isPending}
                      className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-60"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Numbers</h3>

        {numbers.isLoading ? (
          <LoadingBlock />
        ) : (numbers.data ?? []).length === 0 ? (
          <EmptyState
            title="No numbers yet"
            message="A number appears here once its account is connected."
          />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Number</th>
                    <th className="px-4 py-3">Display name</th>
                    <th className="px-4 py-3">Quality</th>
                    <th className="px-4 py-3">Routing id</th>
                    <th className="px-4 py-3">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {numbers.data!.map((number) => (
                    <tr key={number.id}>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {number.display_number}
                        {number.is_default && (
                          <Badge className="ml-2 bg-teal-100 text-teal-800">default</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{number.verified_name ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{number.quality_rating ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {number.phone_number_id}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          className={
                            number.registered
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }
                        >
                          {number.registered ? 'registered' : 'not registered'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <p className="text-xs text-slate-500">
          The routing id is how an inbound message finds this workspace: Meta sends every account's
          traffic to one webhook, and the number it arrived on decides whose data it becomes.
        </p>
      </section>
    </div>
  );
}
