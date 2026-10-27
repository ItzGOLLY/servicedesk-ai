import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
  business_id: string | null;
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
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ waba_id: '', phone_number_id: '', access_token: '' });

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

  const connectManually = useMutation({
    mutationFn: (payload: { waba_id: string; phone_number_id: string; access_token: string }) =>
      api.post<{ numbers: unknown[]; warnings: string[] }>('/platform/connections/manual', payload),
    onSuccess: (response) => {
      const warnings = response.data.warnings ?? [];
      setNotice(
        warnings.length
          ? `Connected, with notes: ${warnings.join(' ')}`
          : 'Number connected. Messages sent to it will arrive here within seconds.'
      );
      setFailure(null);
      setManualOpen(false);
      setManual({ waba_id: '', phone_number_id: '', access_token: '' });
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
          data?: {
            phone_number_id?: string;
            waba_id?: string;
            business_id?: string;
            current_step?: string;
            error_message?: string;
          };
        };

        if (payload.type !== 'WA_EMBEDDED_SIGNUP') return;

        // Meta reports success under several names depending on how the
        // customer onboarded — Cloud API, an existing WhatsApp Business app
        // number, an on-behalf-of migration, or API access only.
        const SUCCESS = [
          'FINISH',
          'FINISH_ONLY_WABA',
          'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
          'FINISH_OBO_MIGRATION',
          'FINISH_GRANT_ONLY_API_ACCESS',
        ];

        if (payload.event && SUCCESS.includes(payload.event)) {
          if (payload.data?.waba_id && payload.data?.phone_number_id) {
            signupResult.current = {
              waba_id: payload.data.waba_id,
              phone_number_id: payload.data.phone_number_id,
              business_id: payload.data.business_id ?? null,
            };
          } else if (payload.data?.waba_id) {
            // FINISH_ONLY_WABA: an account with no number yet. Saying so beats
            // a silent failure when the code arrives without one.
            setFailure(
              'The account was authorised but has no phone number yet. Add one in WhatsApp Manager, then connect again.'
            );
            setLaunching(false);
          }
        } else if (payload.event === 'CANCEL') {
          const reason = payload.data?.error_message
            ? `Meta reported: ${payload.data.error_message}`
            : payload.data?.current_step
              ? `Cancelled at the "${payload.data.current_step}" step.`
              : 'Onboarding was cancelled before it finished.';
          setFailure(reason);
          setLaunching(false);
        } else if (payload.event === 'ERROR') {
          setFailure(payload.data?.error_message ?? 'Meta reported an error during onboarding.');
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

        // Meta's code expires 30 seconds after it is issued, so this is sent
        // immediately rather than after any confirmation step.
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
        // v4 takes `setup` alone. featureType and sessionInfoVersion belonged
        // to v2/v3, which Meta retired on 15 October 2026.
        extras: { setup: {} },
      }
    );
  };

  if (config.isLoading) return <LoadingBlock label="Checking platform configuration…" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Connect WhatsApp"
          subtitle="Onboard a WhatsApp Business number through Meta. Messages to it arrive here within seconds."
        />
        <Link
          to="/admin/connect/help"
          className="btn-secondary shrink-0 whitespace-nowrap px-4 py-2 text-sm"
        >
          Need help?
        </Link>
      </div>

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
                You can still connect a number you already own, using the form below.
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

      {/* Connect a number the business already owns. Works whether or not
          Embedded Signup is configured on this deployment. */}
      <Card>
        <div className="p-5">
          <button
            type="button"
            onClick={() => setManualOpen((open) => !open)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="font-semibold text-slate-900">
                Already have a WhatsApp Business number?
              </span>
              <span className="mt-1 block text-sm text-slate-600">
                Connect it with credentials from Meta instead of going through the dialog.
              </span>
            </span>
            <span className="ml-4 shrink-0 text-sm font-medium text-teal-700">
              {manualOpen ? 'Hide' : 'Connect manually'}
            </span>
          </button>

          {manualOpen && (
            <form
              className="mt-5 space-y-4 border-t border-slate-200 pt-5"
              onSubmit={(event) => {
                event.preventDefault();
                connectManually.mutate(manual);
              }}
            >
              <p className="text-sm text-slate-600">
                Find these in{' '}
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-700 underline"
                >
                  Meta for Developers
                </a>{' '}
                under <strong>WhatsApp &rarr; API Setup</strong>.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-slate-800">
                    WhatsApp Business Account ID
                  </span>
                  <input
                    value={manual.waba_id}
                    onChange={(e) => setManual({ ...manual, waba_id: e.target.value.trim() })}
                    placeholder="1101933506155292"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                    required
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-slate-800">Phone number ID</span>
                  <input
                    value={manual.phone_number_id}
                    onChange={(e) =>
                      setManual({ ...manual, phone_number_id: e.target.value.trim() })
                    }
                    placeholder="1298719266663870"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                    required
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-slate-800">Access token</span>
                <textarea
                  value={manual.access_token}
                  onChange={(e) => setManual({ ...manual, access_token: e.target.value.trim() })}
                  placeholder="EAAG..."
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  required
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Stored encrypted, never shown again, and never sent to your browser after this.
                  A token generated in the API Setup panel expires after 24 hours; a System User
                  token does not.
                </span>
              </label>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={connectManually.isPending}
                  className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {connectManually.isPending ? 'Connecting\u2026' : 'Connect number'}
                </button>
                <span className="text-xs text-slate-500">
                  We will register the number and subscribe to its webhooks.
                </span>
              </div>
            </form>
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
