import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth, homePathFor } from '../context/AuthContext';
import { ApiClientError } from '../lib/api';
import { ErrorNotice, FieldError, Spinner } from '../components/ui';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ fullName: '', email: '', password: '', phone: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setFieldErrors({});
    setSubmitting(true);

    try {
      const user = await register(
        form.fullName.trim(),
        form.email.trim(),
        form.password,
        form.phone.trim() || undefined
      );
      navigate(homePathFor(user.role), { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        // The API returns per-field messages; show them next to the field.
        if (err.details?.length) {
          setFieldErrors(
            Object.fromEntries(err.details.map((detail) => [detail.field, detail.message]))
          );
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-500 font-bold text-white">
            SD
          </div>
          <span className="text-lg font-bold text-ink">ServiceDesk AI</span>
        </Link>

        <div className="card p-8">
          <h1 className="text-xl font-bold text-ink">Create your account</h1>
          <p className="mt-1 text-sm text-slate-500">
            Raise support requests and follow them through to resolution.
          </p>

          {error && (
            <div className="mt-5">
              <ErrorNotice message={error} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            <div>
              <label htmlFor="fullName" className="label">
                Full name
              </label>
              <input
                id="fullName"
                className="input"
                value={form.fullName}
                onChange={update('fullName')}
                autoComplete="name"
                required
                placeholder="Rohan Menon"
              />
              <FieldError message={fieldErrors.fullName} />
            </div>

            <div>
              <label htmlFor="email" className="label">
                Email address
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={form.email}
                onChange={update('email')}
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
              <FieldError message={fieldErrors.email} />
            </div>

            <div>
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={form.password}
                onChange={update('password')}
                autoComplete="new-password"
                required
                placeholder="At least 8 characters"
              />
              <FieldError message={fieldErrors.password} />
              {!fieldErrors.password && (
                <p className="mt-1.5 text-xs text-slate-500">
                  At least 8 characters, including a letter and a number.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="phone" className="label">
                Phone <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="phone"
                className="input"
                value={form.phone}
                onChange={update('phone')}
                autoComplete="tel"
                placeholder="+91 90000 00000"
              />
              <FieldError message={fieldErrors.phone} />
            </div>

            <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner className="h-4 w-4" /> Creating account…
                </>
              ) : (
                'Create account'
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-brand-600 hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
