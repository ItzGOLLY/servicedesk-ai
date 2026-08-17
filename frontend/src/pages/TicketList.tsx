import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import {
  Card,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
} from '../components/ui';
import { TicketRow } from '../components/TicketBits';
import { PRIORITY_OPTIONS, STATUS_OPTIONS, humanise } from '../lib/format';
import type { Category, Ticket, User } from '../lib/types';

interface Props {
  title: string;
  subtitle: string;
  /** Agents and admins get the full filter bar; customers get a simpler one. */
  variant: 'customer' | 'staff';
}

const EMPTY_FILTERS = {
  status: '',
  priority: '',
  categoryId: '',
  agentId: '',
  sentiment: '',
  q: '',
};

export default function TicketList({ title, subtitle, variant }: Props) {
  const { user } = useAuth();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const isStaff = variant === 'staff';

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<User[]>('/users/agents'),
    enabled: isStaff,
  });

  const query = queryString({ ...filters, page, limit: 15 });

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tickets', filters, page],
    queryFn: () => api.get<Ticket[]>(`/tickets${query}`),
  });

  const update = (key: keyof typeof filters) => (event: { target: { value: string } }) => {
    setFilters((prev) => ({ ...prev, [key]: event.target.value }));
    setPage(1); // any filter change invalidates the current page number
  };

  const hasFilters = Object.values(filters).some(Boolean);
  const tickets = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        action={
          user?.role === 'CUSTOMER' ? (
            <Link to="/tickets/new" className="btn-primary">
              New ticket
            </Link>
          ) : undefined
        }
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
              </svg>
              <input
                className="input pl-9"
                placeholder={
                  isStaff
                    ? 'Search reference, subject, customer or keywords…'
                    : 'Search your tickets…'
                }
                value={filters.q}
                onChange={update('q')}
                aria-label="Search tickets"
              />
            </div>
            {hasFilters && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setPage(1);
                }}
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <select className="input" value={filters.status} onChange={update('status')} aria-label="Filter by status">
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {humanise(status)}
                </option>
              ))}
            </select>

            <select className="input" value={filters.priority} onChange={update('priority')} aria-label="Filter by priority">
              <option value="">All priorities</option>
              {PRIORITY_OPTIONS.map((priority) => (
                <option key={priority} value={priority}>
                  {humanise(priority)}
                </option>
              ))}
            </select>

            <select className="input" value={filters.categoryId} onChange={update('categoryId')} aria-label="Filter by category">
              <option value="">All categories</option>
              {categories?.data.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>

            {isStaff && (
              <>
                <select className="input" value={filters.agentId} onChange={update('agentId')} aria-label="Filter by agent">
                  <option value="">All agents</option>
                  <option value="unassigned">Unassigned</option>
                  {agents?.data.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.fullName}
                    </option>
                  ))}
                </select>

                <select className="input" value={filters.sentiment} onChange={update('sentiment')} aria-label="Filter by sentiment">
                  <option value="">All sentiment</option>
                  <option value="POSITIVE">Positive</option>
                  <option value="NEUTRAL">Neutral</option>
                  <option value="NEGATIVE">Negative</option>
                </select>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : isError ? (
          <div className="p-4">
            <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No tickets match those filters' : 'No tickets yet'}
            message={
              hasFilters
                ? 'Try widening your search or clearing the filters.'
                : isStaff
                  ? 'Tickets raised by customers will appear in this queue.'
                  : 'When you raise a support request it will appear here.'
            }
          />
        ) : (
          <>
            <ul>
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <TicketRow ticket={ticket} showCustomer={isStaff} />
                </li>
              ))}
            </ul>
            {meta && (
              <Pagination
                page={meta.page}
                totalPages={meta.totalPages}
                total={meta.total}
                onChange={setPage}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
