import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError, queryString } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorNotice,
  FieldError,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
} from '../../components/ui';
import { formatDate, initials } from '../../lib/format';
import type { User, UserRole } from '../../lib/types';

const ROLE_STYLES: Record<UserRole, string> = {
  CUSTOMER: 'bg-slate-100 text-slate-700',
  AGENT: 'bg-brand-100 text-brand-800',
  ADMIN: 'bg-ink text-white',
};

export default function UserManagement() {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState({ role: '', q: '' });
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [actionError, setActionError] = useState('');

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    role: 'AGENT' as UserRole,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['users', filters, page],
    queryFn: () => api.get<User[]>(`/users${queryString({ ...filters, page, limit: 15 })}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  const createUser = useMutation({
    mutationFn: () => api.post<User>('/users', form),
    onSuccess: () => {
      setModalOpen(false);
      setForm({ fullName: '', email: '', password: '', role: 'AGENT' });
      setFieldErrors({});
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.details?.length) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      } else {
        setFieldErrors({ email: err instanceof Error ? err.message : 'Could not create the user.' });
      }
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) =>
      api.patch(`/users/${id}/role`, { role }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Could not change the role.'),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/users/${id}/status`, { isActive }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Could not update the account.'),
  });

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    createUser.mutate();
  };

  const users = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div>
      <PageHeader
        title="Users and agents"
        subtitle="Create accounts, change roles and deactivate access."
        action={
          <button type="button" className="btn-primary" onClick={() => setModalOpen(true)}>
            Add user
          </button>
        }
      />

      {actionError && (
        <div className="mb-5">
          <ErrorNotice message={actionError} />
        </div>
      )}

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className="input sm:col-span-2"
            placeholder="Search by name or email…"
            value={filters.q}
            onChange={(event) => {
              setFilters((prev) => ({ ...prev, q: event.target.value }));
              setPage(1);
            }}
            aria-label="Search users"
          />
          <select
            className="input"
            value={filters.role}
            onChange={(event) => {
              setFilters((prev) => ({ ...prev, role: event.target.value }));
              setPage(1);
            }}
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            <option value="CUSTOMER">Customer</option>
            <option value="AGENT">Support agent</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : isError ? (
          <div className="p-4">
            <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />
          </div>
        ) : users.length === 0 ? (
          <EmptyState title="No users found" message="Try a different search or filter." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3 font-semibold">User</th>
                    <th className="px-5 py-3 font-semibold">Role</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 font-semibold">Joined</th>
                    <th className="px-5 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
                            {initials(user.fullName)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink">{user.fullName}</p>
                            <p className="truncate text-xs text-slate-500">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`badge ${ROLE_STYLES[user.role]}`}>{user.role}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`badge ${
                            user.isActive
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {user.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-600">{formatDate(user.createdAt)}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <select
                            className="input w-32 py-1.5 text-xs"
                            value={user.role}
                            onChange={(event) =>
                              changeRole.mutate({ id: user.id, role: event.target.value as UserRole })
                            }
                            aria-label={`Change role for ${user.fullName}`}
                          >
                            <option value="CUSTOMER">Customer</option>
                            <option value="AGENT">Agent</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                          <button
                            type="button"
                            className={user.isActive ? 'btn-secondary px-3 py-1.5 text-xs' : 'btn-primary px-3 py-1.5 text-xs'}
                            onClick={() =>
                              changeStatus.mutate({ id: user.id, isActive: !user.isActive })
                            }
                          >
                            {user.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {meta && (
              <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} onChange={setPage} />
            )}
          </>
        )}
      </Card>

      <Modal open={modalOpen} title="Add a user" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4" noValidate>
          <div>
            <label htmlFor="fullName" className="label">
              Full name
            </label>
            <input
              id="fullName"
              className="input"
              value={form.fullName}
              onChange={(e) => setForm((p) => ({ ...p, fullName: e.target.value }))}
              required
            />
            <FieldError message={fieldErrors.fullName} />
          </div>

          <div>
            <label htmlFor="newEmail" className="label">
              Email address
            </label>
            <input
              id="newEmail"
              type="email"
              className="input"
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              required
            />
            <FieldError message={fieldErrors.email} />
          </div>

          <div>
            <label htmlFor="newPassword" className="label">
              Temporary password
            </label>
            <input
              id="newPassword"
              type="text"
              className="input"
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              placeholder="At least 8 characters"
              required
            />
            <FieldError message={fieldErrors.password} />
            <p className="mt-1.5 text-xs text-slate-500">
              Share this with the user and ask them to change it after signing in.
            </p>
          </div>

          <div>
            <label htmlFor="newRole" className="label">
              Role
            </label>
            <select
              id="newRole"
              className="input"
              value={form.role}
              onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as UserRole }))}
            >
              <option value="CUSTOMER">Customer</option>
              <option value="AGENT">Support agent</option>
              <option value="ADMIN">Admin</option>
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" className="btn-primary" disabled={createUser.isPending}>
              {createUser.isPending ? (
                <>
                  <Spinner className="h-4 w-4" /> Creating…
                </>
              ) : (
                'Create user'
              )}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
