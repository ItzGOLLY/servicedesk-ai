import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../../lib/api';
import { Card, PageHeader, Badge } from '../../components/ui';

/**
 * Setup guide for connecting a WhatsApp number.
 *
 * Written for a business owner, not a developer: it says where each value
 * lives in Meta's dashboard, which of the two routes applies to them, and
 * what the common failures actually mean. The values that belong to this
 * deployment — the webhook URL above all — are rendered from the API rather
 * than written into the prose, so the page cannot drift from reality.
 */

interface SignupConfig {
  app_id: string;
  config_id: string;
  graph_version: string;
  configured: boolean;
}

function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-800">{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
        className="text-xs font-medium text-brand-600 hover:underline"
      >
        {copied ? 'Copied' : label ?? 'Copy'}
      </button>
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">
        {n}
      </span>
      <div className="min-w-0 flex-1 pb-6">
        <h4 className="font-semibold text-ink">{title}</h4>
        <div className="mt-1.5 space-y-2 text-sm text-slate-600">{children}</div>
      </div>
    </div>
  );
}

export default function ConnectHelp() {
  const config = useQuery({
    queryKey: ['signup-config'],
    queryFn: () => api.get<SignupConfig>('/platform/signup-config').then((r) => r.data),
  });

  // The webhook address is this deployment's, so it is derived rather than
  // hard-coded: a reader can copy it straight into Meta.
  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/api\/?$/, '');
  const webhookUrl = `${apiBase}/api/webhooks/meta`;

  const esReady = config.data?.configured ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setting up WhatsApp"
        subtitle="Two ways to connect a number, and where to find each value Meta asks for."
      />

      <Card>
        <div className="p-5">
          <h3 className="font-semibold text-ink">Which route applies to you?</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">Starting from scratch</span>
                {esReady ? (
                  <Badge className="bg-emerald-100 text-emerald-800">available</Badge>
                ) : (
                  <Badge className="bg-amber-100 text-amber-800">not configured</Badge>
                )}
              </div>
              <p className="mt-2 text-sm text-slate-600">
                You have no WhatsApp Business account yet. Use{' '}
                <strong>Connect with Facebook</strong>. Meta creates the account and the number
                inside its own dialog — you need only a Facebook account. Nothing to look up.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">You already have one</span>
                <Badge className="bg-emerald-100 text-emerald-800">available</Badge>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                You already use the WhatsApp Business API, perhaps through another provider. Use{' '}
                <strong>Connect manually</strong> and paste three values from Meta. Follow the
                steps below.
              </p>
            </div>
          </div>
          <Link to="/admin/connect" className="btn-primary mt-5 inline-flex">
            Go to Connect WhatsApp
          </Link>
        </div>
      </Card>

      <Card>
        <div className="p-5">
          <h3 className="font-semibold text-ink">Connecting a number you already have</h3>
          <p className="mt-1 text-sm text-slate-600">
            Everything below lives at{' '}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 underline"
            >
              developers.facebook.com
            </a>
            , inside your app.
          </p>

          <div className="mt-6">
            <Step n={1} title="Open WhatsApp → API Setup">
              <p>
                In the left sidebar of your Meta app, expand <strong>WhatsApp</strong> and choose{' '}
                <strong>API Setup</strong>. Everything in steps 2 to 4 is on that one page.
              </p>
            </Step>

            <Step n={2} title="Copy the two IDs">
              <p>
                Under the <strong>From</strong> dropdown you will see two numbers. They look alike
                — take care not to swap them, and do not use your App ID.
              </p>
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  <strong>Phone number ID</strong> — directly under the number
                </li>
                <li>
                  <strong>WhatsApp Business Account ID</strong> — just below it. Newer dashboards
                  call this the <em>Messaging account ID</em>; it is the same value.
                </li>
              </ul>
            </Step>

            <Step n={3} title="Generate an access token">
              <p>
                Press <strong>Generate access token</strong> on the same page and copy it in full —
                it is long and easy to truncate.
              </p>
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                This token <strong>expires after 24 hours</strong>. For something permanent, create
                a System User token in Business Settings with the{' '}
                <code className="rounded bg-white px-1">whatsapp_business_messaging</code> and{' '}
                <code className="rounded bg-white px-1">whatsapp_business_management</code>{' '}
                permissions and no expiry.
              </p>
            </Step>

            <Step n={4} title="Allow the phones you will test with">
              <p>
                Still on API Setup, under <strong>To</strong>, open{' '}
                <strong>Manage phone number list</strong> and add your own number. Meta's test
                sender only delivers to numbers on that list, so skipping this makes it look as
                though nothing works.
              </p>
            </Step>

            <Step n={5} title="Point Meta at us">
              <p>
                Go to <strong>WhatsApp → Configuration → Webhook → Edit</strong> and set the
                callback URL to:
              </p>
              <p>
                <Copyable value={webhookUrl} />
              </p>
              <p>
                The verify token is any phrase you choose, as long as it matches the one configured
                on this deployment. Then open <strong>Webhook fields → Manage</strong> and
                subscribe to <strong>messages</strong>.
              </p>
            </Step>

            <Step n={6} title="Paste the three values here">
              <p>
                Open <Link to="/admin/connect" className="text-brand-600 underline">Connect WhatsApp</Link>,
                choose <strong>Connect manually</strong>, and submit. We validate the token with
                Meta, register the number, and subscribe to its webhooks — the last step is the one
                Meta's dashboard does not perform, and without it no message is ever delivered.
              </p>
            </Step>
          </div>
        </div>
      </Card>

      <Card>
        <div className="p-5">
          <h3 className="font-semibold text-ink">When something does not work</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">What you see</th>
                  <th className="py-2">What it means</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    “Meta rejected that access token”
                  </td>
                  <td className="py-3 text-slate-600">
                    It expired after 24 hours, or was truncated when copied. Generate a new one.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    “Cannot read that WhatsApp Business Account”
                  </td>
                  <td className="py-3 text-slate-600">
                    The account ID is wrong — most often the App ID was pasted instead.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    Connected, but no message arrives
                  </td>
                  <td className="py-3 text-slate-600">
                    The webhook is not subscribed to <strong>messages</strong>, or the callback URL
                    does not match the one above. Check the Message log — inbound messages appear
                    there the moment Meta delivers them.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">A reply is not delivered</td>
                  <td className="py-3 text-slate-600">
                    WhatsApp only allows free-form replies within 24 hours of the customer's own
                    message. Outside that window an approved template is required.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    “Already connected to another workspace”
                  </td>
                  <td className="py-3 text-slate-600">
                    That WhatsApp account belongs to a different business here. One account cannot
                    serve two, or their messages would mix.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    “Connect with Facebook” is greyed out
                  </td>
                  <td className="py-3 text-slate-600">
                    This deployment has no Embedded Signup configuration yet. Use the manual route
                    in the meantime; both end in the same place.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card>
        <div className="p-5">
          <h3 className="font-semibold text-ink">What we store, and what we never see</h3>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>
              Your access token is <strong>encrypted before it is written down</strong> and is never
              sent back to a browser. Logs carry a short fingerprint, never the token.
            </li>
            <li>
              We never see your Facebook password. In the Embedded Signup route you type it into
              Meta's own dialog, and we receive only a short-lived code that our server exchanges.
            </li>
            <li>
              Your messages, contacts and tickets belong to your workspace alone. No other business
              on this platform can read them.
            </li>
            <li>
              Disconnecting destroys the stored token and stops delivery. Your message history
              stays, so your records remain intact.
            </li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
