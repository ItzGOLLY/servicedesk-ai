import { queryOne } from '../../db/pool';
import { ApiError } from '../../utils/ApiError';

/**
 * Resolving which business a request belongs to.
 *
 * Authenticated requests carry the tenant on req.user. Two paths cannot:
 * self-registration on the web portal, and the first-party WhatsApp number
 * this deployment owns. Both resolve to the deployment's own workspace — the
 * tenant created by migration 006, which every pre-existing row was attributed
 * to.
 *
 * A production platform would resolve the portal's tenant from its hostname
 * (acme.servicedesk.app) or from an invitation token. That is deliberately not
 * guessed at here: one workspace per deployment is the honest description of
 * what this code does.
 */

export interface TenantRef {
  tenantId: string;
  slug: string;
}

/** Cached because it is read on every registration and never changes. */
let cached: TenantRef | null = null;

export async function defaultTenant(): Promise<TenantRef> {
  if (cached) return cached;

  const row = await queryOne<{ id: string; slug: string }>(
    'SELECT id, slug FROM tenants ORDER BY created_at LIMIT 1'
  );
  if (!row) {
    throw ApiError.internal('No workspace exists. Run the migrations and seed before using the API.');
  }

  cached = { tenantId: row.id, slug: row.slug };
  return cached;
}

/** Tests truncate and recreate tenants between cases, so the cache must clear. */
export function resetTenantCache(): void {
  cached = null;
}
