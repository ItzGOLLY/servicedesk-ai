import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
} from '../../components/ui';
import type { Category } from '../../lib/types';

export default function CategoryManagement() {
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [actionError, setActionError] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['categories', 'admin'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['categories'] });

  const createCategory = useMutation({
    mutationFn: () =>
      api.post<Category>('/categories', {
        name: form.name.trim(),
        description: form.description.trim() || null,
      }),
    onSuccess: () => {
      setModalOpen(false);
      setForm({ name: '', description: '' });
      setActionError('');
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Could not create the category.'),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/categories/${id}`, { isActive }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Could not update the category.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    // The API refuses to delete a category that is in use; show that reason.
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Could not delete the category.'),
  });

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    createCategory.mutate();
  };

  const categories = data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Categories"
        subtitle="How tickets are grouped. The AI classifier only ever proposes a category from this list."
        action={
          <button type="button" className="btn-primary" onClick={() => setModalOpen(true)}>
            Add category
          </button>
        }
      />

      {actionError && (
        <div className="mb-5">
          <ErrorNotice message={actionError} />
        </div>
      )}

      {isLoading ? (
        <LoadingBlock />
      ) : isError ? (
        <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />
      ) : categories.length === 0 ? (
        <Card>
          <EmptyState
            title="No categories yet"
            message="Add a category so tickets can be grouped and reported on."
            action={
              <button type="button" className="btn-primary" onClick={() => setModalOpen(true)}>
                Add your first category
              </button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => (
            <Card key={category.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-ink">{category.name}</h3>
                <span
                  className={`badge ${
                    category.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {category.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <p className="mt-2 flex-1 text-sm text-slate-600">
                {category.description ?? 'No description.'}
              </p>

              <p className="mt-3 text-sm text-slate-500">
                <span className="font-semibold text-ink">{category.ticketCount ?? 0}</span> ticket
                {category.ticketCount === 1 ? '' : 's'}
              </p>

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className="btn-secondary flex-1 px-3 py-2 text-xs"
                  onClick={() =>
                    toggleActive.mutate({ id: category.id, isActive: !category.isActive })
                  }
                >
                  {category.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  type="button"
                  className="btn-danger px-3 py-2 text-xs"
                  onClick={() => remove.mutate(category.id)}
                  disabled={remove.isPending}
                >
                  Delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add a category" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4" noValidate>
          <div>
            <label htmlFor="name" className="label">
              Name
            </label>
            <input
              id="name"
              className="input"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Billing"
              required
            />
          </div>

          <div>
            <label htmlFor="description" className="label">
              Description <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea
              id="description"
              className="input min-h-24 resize-y"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Payments, invoices, refunds and subscription charges"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" className="btn-primary" disabled={createCategory.isPending}>
              {createCategory.isPending ? (
                <>
                  <Spinner className="h-4 w-4" /> Creating…
                </>
              ) : (
                'Create category'
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
