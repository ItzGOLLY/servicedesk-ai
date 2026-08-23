import type { Request } from 'express';
import { query } from '../db/pool';
import { loggerFor } from '../observability/logger';

const log = loggerFor('audit');

/**
 * Records a privileged action.
 *
 * Auditing must never be the reason a successful operation reports failure, so
 * a logging error is swallowed and reported to the server console instead.
 */
export async function recordAudit(
  req: Request,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user?.id ?? null, action, entityType, entityId, JSON.stringify(metadata), req.ip ?? null]
    );
  } catch (error) {
    log.error({ err: (error as Error).message, action, entityType }, 'failed to record audit entry');
  }
}
