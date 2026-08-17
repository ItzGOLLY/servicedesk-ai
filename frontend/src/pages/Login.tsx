import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth, homePathFor } from '../context/AuthContext';
import { ApiClientError } from '../lib/api';
import { ErrorNotice, Spinner } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const user = await login(email.trim(), password);
      navigate(homePathFor(user.role), { replace: true });
    } catch (err) {
      // Show the server's message, which is deliberately generic for bad credentials.
      setError(
        err instanceof ApiClientError ? err.message : 'Could not sign in. Please try again.'
      );
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
          <h1 className="text-xl font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Welcome back. Enter your details to continue.</p>

          {error && (
            <div className="mt-5">
              <ErrorNotice message={error} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            <div>
              <label htmlFor="email" className="label">
                Email address
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
              />
            </div>

            <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner className="h-4 w-4" /> Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            Do not have an account?{' '}
            <Link to="/register" className="font-semibold text-brand-600 hover:underline">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
