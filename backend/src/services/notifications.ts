import { query } from '../db/pool';
import { loggerFor } from '../observability/logger';

const log = loggerFor('notifications');

export type NotificationType =
  | 'TICKET_CREATED'
  | 'TICKET_ASSIGNED'
  | 'TICKET_STATUS_CHANGED'
  | 'TICKET_REPLY'
  | 'TICKET_RESOLVED';

/**
 * Writes an in-app notification.
 *
 * Like auditing, this is best-effort: failing to notify should not roll back the
 * ticket change that caused it.
 */
export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  ticketId: string | null = null
): Promise<void> {
  try {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, ticket_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body, ticketId]
    );
  } catch (error) {
    log.error({ err: (error as Error).message, type }, 'failed to create notification');
  }
}

/** Notifies every admin — used for system-level thresholds. */
export async function notifyAdmins(
  type: NotificationType,
  title: string,
  body: string,
  ticketId: string | null = null
): Promise<void> {
  const admins = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'ADMIN' AND is_active = TRUE`
  );
  await Promise.all(admins.map((a) => notify(a.id, type, title, body, ticketId)));
}
