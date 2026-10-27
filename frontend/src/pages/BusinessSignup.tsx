import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setAccessToken } from '../lib/api';
import { FieldError } from '../components/ui';
import { useAuth } from '../context/AuthContext';

/**
 * Public sign-up for a business, not a customer.
 *
 * This is the platform's front door: it creates a new workspace and makes the
 * person signing up its administrator, so they can connect their own WhatsApp
 * number and issue their own API keys. /register, by contrast, adds a customer
 * to an existing business's support desk.
 *
 * On success it goes straight to the WhatsApp connection screen, because that
 * is the only reason anyone signs up here.
 */

interface SignupResponse {
  user: { id: string; email: string; fullName: string; role: string };
  accessToken: string;
  workspace: { slug: string; name: string };
}

export default function BusinessSignup() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const [form, setForm] = useState({
    businessName: '',
    fullName: '',
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: event.target.value });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFailure(null);
    setErrors({});

    try {
      const response = await api.post<SignupResponse>('/auth/register-business', form);
      setAccessToken(response.data.accessToken);
      await refreshUser();
      // Straight to the thing they came for.
      navigate('/admin/connect', { replace: true });
    } catch (error) {
      const err = error as Error & { details?: Array<{ field: string; message: string }> };
      if (err.details?.length) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      } else {
        setFailure(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-lg">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            SD
          </span>
          <span className="text-lg font-semibold text-ink">ServiceDesk AI</span>
        </Link>

        <div className="rounded-xl border border-slate-200 bg-white p-7 shadow-sm">
          <h1 className="text-xl font-semibold text-ink">Connect your WhatsApp</h1>
          <p className="mt-1 text-sm text-slate-600">
            Create a workspace for your business. You will be able to connect your WhatsApp
            Business number, and every message to it becomes a tracked ticket.
          </p>

          {failure && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {failure}
            </div>
          )}

          <form className="mt-5 space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="text-sm font-medium text-slate-800">Business name</span>
              <input
                value={form.businessName}
                onChange={set('businessName')}
                placeholder="Acme Retail"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <FieldError message={errors.businessName} />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-800">Your name</span>
              <input
                value={form.fullName}
                onChange={set('fullName')}
                placeholder="Asha Rao"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <FieldError message={errors.fullName} />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-800">Work email</span>
              <input
                type="email"
                value={form.email}
                onChange={set('email')}
                placeholder="you@acme.com"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <FieldError message={errors.email} />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-800">Password</span>
              <input
                type="password"
                value={form.password}
                onChange={set('password')}
                placeholder="At least 8 characters, with a letter and a digit"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <FieldError message={errors.password} />
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary w-full py-2.5 disabled:opacity-60"
            >
              {submitting ? 'Creating your workspace…' : 'Create workspace'}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-600">
            Already have a workspace?{' '}
            <Link to="/login" className="font-medium text-brand-600 hover:underline">
              Sign in
            </Link>
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          Looking for help with an order instead?{' '}
          <Link to="/register" className="underline">
            Create a customer account
          </Link>
        </p>
      </div>
    </div>
  );
}
