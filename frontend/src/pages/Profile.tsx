import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiClientError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorNotice, FieldError, PageHeader, Spinner } from '../components/ui';
import { formatDate, humanise, initials } from '../lib/format';

export default function Profile() {
  const { user, refreshUser } = useAuth();

  const [profile, setProfile] = useState({
    fullName: user?.fullName ?? '',
    phone: user?.phone ?? '',
  });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [profileMessage, setProfileMessage] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch('/users/me', {
        fullName: profile.fullName.trim(),
        phone: profile.phone.trim() || null,
      }),
    onSuccess: async () => {
      setProfileError('');
      setProfileMessage('Profile updated.');
      await refreshUser();
    },
    onError: (err) =>
      setProfileError(err instanceof Error ? err.message : 'Could not update your profile.'),
  });

  const changePassword = useMutation({
    mutationFn: () => api.patch('/users/me/password', passwords),
    onSuccess: () => {
      setPasswordErrors({});
      setPasswordMessage('Password changed.');
      setPasswords({ currentPassword: '', newPassword: '' });
    },
    onError: (err) => {
      setPasswordMessage('');
      if (err instanceof ApiClientError && err.details?.length) {
        setPasswordErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      } else {
        setPasswordErrors({
          currentPassword: err instanceof Error ? err.message : 'Could not change your password.',
        });
      }
    },
  });

  if (!user) return null;

  const handleProfile = (event: FormEvent) => {
    event.preventDefault();
    setProfileMessage('');
    saveProfile.mutate();
  };

  const handlePassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordMessage('');
    setPasswordErrors({});
    changePassword.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Your profile" subtitle="Manage your details and password." />

      <Card className="mb-6 p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-lg font-semibold text-white">
            {initials(user.fullName)}
          </div>
          <div>
            <p className="text-lg font-semibold text-ink">{user.fullName}</p>
            <p className="text-sm text-slate-500">{user.email}</p>
            <p className="mt-1 text-xs text-slate-400">
              {humanise(user.role)} · joined {formatDate(user.createdAt)}
            </p>
          </div>
        </div>
      </Card>

      <Card className="mb-6 p-6">
        <h2 className="font-semibold text-ink">Details</h2>

        {profileError && (
          <div className="mt-4">
            <ErrorNotice message={profileError} />
          </div>
        )}
        {profileMessage && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
            {profileMessage}
          </p>
        )}

        <form onSubmit={handleProfile} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="fullName" className="label">
              Full name
            </label>
            <input
              id="fullName"
              className="input"
              value={profile.fullName}
              onChange={(e) => setProfile((p) => ({ ...p, fullName: e.target.value }))}
              required
            />
          </div>

          <div>
            <label htmlFor="phone" className="label">
              Phone
            </label>
            <input
              id="phone"
              className="input"
              value={profile.phone}
              onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))}
              placeholder="+91 90000 00000"
            />
          </div>

          {/* Email and role are deliberately read-only: changing a role is an
              administrative action, enforced by the API. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="emailReadonly">
                Email address
              </label>
              <input id="emailReadonly" className="input" value={user.email} disabled />
            </div>
            <div>
              <label className="label" htmlFor="roleReadonly">
                Role
              </label>
              <input id="roleReadonly" className="input" value={humanise(user.role)} disabled />
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={saveProfile.isPending}>
            {saveProfile.isPending ? (
              <>
                <Spinner className="h-4 w-4" /> Saving…
              </>
            ) : (
              'Save changes'
            )}
          </button>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold text-ink">Change password</h2>

        {passwordMessage && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
            {passwordMessage}
          </p>
        )}

        <form onSubmit={handlePassword} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="currentPassword" className="label">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              className="input"
              value={passwords.currentPassword}
              onChange={(e) => setPasswords((p) => ({ ...p, currentPassword: e.target.value }))}
              autoComplete="current-password"
              required
            />
            <FieldError message={passwordErrors.currentPassword} />
          </div>

          <div>
            <label htmlFor="newPassword" className="label">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              className="input"
              value={passwords.newPassword}
              onChange={(e) => setPasswords((p) => ({ ...p, newPassword: e.target.value }))}
              autoComplete="new-password"
              required
            />
            <FieldError message={passwordErrors.newPassword} />
            {!passwordErrors.newPassword && (
              <p className="mt-1.5 text-xs text-slate-500">
                At least 8 characters, including a letter and a number.
              </p>
            )}
          </div>

          <button type="submit" className="btn-primary" disabled={changePassword.isPending}>
            {changePassword.isPending ? (
              <>
                <Spinner className="h-4 w-4" /> Updating…
              </>
            ) : (
              'Change password'
            )}
          </button>
        </form>
      </Card>
    </div>
  );
}
