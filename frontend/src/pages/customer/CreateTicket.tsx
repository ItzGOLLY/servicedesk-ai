import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '../../lib/api';
import { Card, ErrorNotice, FieldError, PageHeader, Spinner } from '../../components/ui';
import { PRIORITY_OPTIONS, humanise } from '../../lib/format';
import type { Category, Ticket } from '../../lib/types';

export default function CreateTicket() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    subject: '',
    description: '',
    categoryId: '',
    priority: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Ticket>('/tickets', {
        subject: form.subject.trim(),
        description: form.description.trim(),
        ...(form.categoryId ? { categoryId: form.categoryId } : {}),
        ...(form.priority ? { priority: form.priority } : {}),
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      navigate(`/tickets/${response.data.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.details?.length) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the ticket.');
      }
    },
  });

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setFieldErrors({});
    mutation.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Create a support ticket"
        subtitle="Describe the problem and we will get back to you."
      />

      <Card className="p-6 sm:p-8">
        {error && (
          <div className="mb-5">
            <ErrorNotice message={error} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div>
            <label htmlFor="subject" className="label">
              Subject
            </label>
            <input
              id="subject"
              className="input"
              value={form.subject}
              onChange={update('subject')}
              placeholder="Payment deducted but order still pending"
              required
            />
            <FieldError message={fieldErrors.subject} />
          </div>

          <div>
            <label htmlFor="description" className="label">
              Description
            </label>
            <textarea
              id="description"
              className="input min-h-40 resize-y"
              value={form.description}
              onChange={update('description')}
              placeholder="Tell us what happened, including any order or reference number."
              required
            />
            <FieldError message={fieldErrors.description} />
            <p className="mt-1.5 text-xs text-slate-500">
              The more detail you give, the faster we can help.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="categoryId" className="label">
                Category <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <select
                id="categoryId"
                className="input"
                value={form.categoryId}
                onChange={update('categoryId')}
              >
                <option value="">Let the system decide</option>
                {categories?.data.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {/* Optional on purpose: the customer is never blocked on the AI. */}
              <p className="mt-1.5 text-xs text-slate-500">
                Leave blank and we will categorise it for you.
              </p>
            </div>

            <div>
              <label htmlFor="priority" className="label">
                Priority <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <select id="priority" className="input" value={form.priority} onChange={update('priority')}>
                <option value="">Let the system decide</option>
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {humanise(priority)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <button type="submit" className="btn-primary" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Spinner className="h-4 w-4" /> Submitting…
                </>
              ) : (
                'Submit ticket'
              )}
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
              Cancel
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
