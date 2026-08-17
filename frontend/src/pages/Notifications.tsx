import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, ErrorNotice, LoadingBlock, PageHeader } from '../components/ui';
import { timeAgo } from '../lib/format';
import type { Notification } from '../lib/types';

export default function Notifications() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<Notification[]>('/notifications?limit=50'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.patch('/notifications/read-all'),
    onSuccess: invalidate,
  });

  const notifications = data?.data ?? [];
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up.'}
        action={
          unreadCount > 0 ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              Mark all as read
            </button>
          ) : undefined
        }
      />

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : isError ? (
          <div className="p-4">
            <ErrorNotice message={(error as Error).message} onRetry={() => void refetch()} />
          </div>
        ) : notifications.length === 0 ? (
          <EmptyState
            title="No notifications"
            message="You will be notified when a ticket is assigned, replied to or resolved."
          />
        ) : (
          <ul>
            {notifications.map((notification) => (
              <li
                key={notification.id}
                className={`border-b border-slate-100 last:border-0 ${
                  notification.isRead ? '' : 'bg-brand-50/50'
                }`}
              >
                <div className="flex gap-4 px-5 py-4">
                  <div
                    className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                      notification.isRead ? 'bg-slate-300' : 'bg-brand-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{notification.title}</p>
                    <p className="mt-0.5 text-sm text-slate-600">{notification.body}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      <span className="text-slate-400">{timeAgo(notification.createdAt)}</span>
                      {notification.ticketId && (
                        <Link
                          to={`/tickets/${notification.ticketId}`}
                          className="font-semibold text-brand-600 hover:underline"
                        >
                          View {notification.ticketReference ?? 'ticket'}
                        </Link>
                      )}
                      {!notification.isRead && (
                        <button
                          type="button"
                          className="font-semibold text-slate-500 hover:underline"
                          onClick={() => markRead.mutate(notification.id)}
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
