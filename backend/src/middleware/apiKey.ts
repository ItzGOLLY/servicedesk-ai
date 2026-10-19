import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { query, queryOne } from '../db/pool';
import { sha256 } from '../utils/crypto';

/**
 * Authenticates a machine caller by API key.
 *
 * This is the other way into the platform: a tenant's own software calls the
 * public API with a key rather than signing in as a person. It sets
 * req.apiTenantId instead of req.user, because there is no user — attributing
 * a programmatic action to a human would make the audit log lie.
 *
 * The key is looked up by its SHA-256 hash, so the database never holds
 * anything that can be replayed. The lookup is by hash rather than by prefix
 * then compare, so a wrong key costs exactly one indexed query.
 */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;

    // Bearer is the documented form; x-api-key is accepted because enough
    // HTTP clients make custom headers easier than Authorization.
    const presented = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : (req.headers['x-api-key'] as string | undefined)?.trim();

    if (!presented) {
      throw ApiError.unauthorized('Provide an API key as "Authorization: Bearer <key>".');
    }

    const record = await queryOne<{
      id: string;
      tenant_id: string;
      revoked_at: Date | null;
      tenant_status: string;
    }>(
      `SELECT k.id, k.tenant_id, k.revoked_at, t.status::TEXT AS tenant_status
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = $1`,
      [sha256(presented)]
    );

    // One message for "no such key" and "revoked key": telling them apart
    // would confirm that a revoked key was once real.
    if (!record || record.revoked_at) {
      throw ApiError.unauthorized('Invalid API key.');
    }

    if (record.tenant_status !== 'ACTIVE') {
      throw ApiError.forbidden('This account is suspended.');
    }

    req.apiTenantId = record.tenant_id;
    req.apiKeyId = record.id;

    // Fire-and-forget: last_used_at is for the console, and must not add
    // latency or fail the request if the write errors.
    void query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [record.id]).catch(() => {});

    next();
  } catch (error) {
    next(error);
  }
}

/** The tenant for the current request, whichever way it authenticated. */
export function tenantOf(req: Request): string {
  const tenantId = req.apiTenantId ?? req.user?.tenantId;
  if (!tenantId) throw ApiError.unauthorized('No tenant on this request.');
  return tenantId;
}
