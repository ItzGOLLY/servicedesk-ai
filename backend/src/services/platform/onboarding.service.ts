import { query, queryOne, withTransaction } from '../../db/pool';
import { env } from '../../config/env';
import { encryptSecret, decryptSecret, fingerprint } from '../../utils/crypto';
import { loggerFor } from '../../observability/logger';
import * as graph from './graph.client';
import { GraphApiError } from './graph.client';

const log = loggerFor('onboarding');

/**
 * Turns the result of Embedded Signup into a working connection.
 *
 * Meta's dialog hands back three things — a code, a WABA id and a phone number
 * id — and nothing works yet. Four server-side steps have to follow, and the
 * order matters:
 *
 *   1. Exchange the code for a business token (needs the app secret).
 *   2. Register the number for Cloud API (skipped if already registered).
 *   3. Subscribe our app to the customer's webhooks — the step Meta's own
 *      dashboard does not perform and without which nothing is ever delivered.
 *   4. Read back the account and numbers so the console shows real values
 *      rather than what we hoped happened.
 *
 * Each step records its outcome, so a half-finished onboarding is visible and
 * resumable instead of looking identical to a successful one.
 */

export interface EmbeddedSignupInput {
  tenantId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  onboardedBy?: string | null;
}

export interface ConnectionRecord {
  id: string;
  tenant_id: string;
  waba_id: string;
  waac_id: string | null;
  business_id: string | null;
  business_name: string | null;
  status: 'PENDING' | 'ACTIVE' | 'ERROR' | 'DISCONNECTED';
  error_detail: string | null;
  token_fingerprint: string;
  subscribed_at: Date | null;
  created_at: Date;
}

export interface OnboardingResult {
  connectionId: string;
  status: ConnectionRecord['status'];
  numbers: Array<{ id: string; phoneNumberId: string; displayNumber: string; registered: boolean }>;
  warnings: string[];
}

/**
 * Meta returns this when the number is already registered — which is the
 * normal case for coexistence onboarding, not a failure.
 */
function isAlreadyRegistered(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  return error.code === 133_005 || /already.*registered/i.test(error.message);
}

export async function completeEmbeddedSignup(input: EmbeddedSignupInput): Promise<OnboardingResult> {
  // Step 1 — the code is single-use and expires in 30 seconds, so it is
  // exchanged first and nothing is written until it succeeds.
  const token = await graph.exchangeCodeForToken(input.code);

  log.info(
    { tenantId: input.tenantId, wabaId: input.wabaId, tokenPrint: fingerprint(token) },
    'exchanged signup code'
  );

  return connectWithToken({ ...input, accessToken: token });
}

export interface ManualConnectInput {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  onboardedBy?: string | null;
}

/**
 * Connects a number using credentials the business already holds.
 *
 * Embedded Signup is the flow for onboarding a customer who has never used
 * the WhatsApp API. A business that already has a WhatsApp Business Account
 * and a token — because they set it up themselves, or they are migrating from
 * another provider — has nothing to authorise, so sending them through a
 * consent dialog would be theatre.
 *
 * Both paths converge on the same code below, so a manually connected number
 * is indistinguishable afterwards: same registration, same webhook
 * subscription, same encrypted storage, same routing.
 */
export async function connectManually(input: ManualConnectInput): Promise<OnboardingResult> {
  log.info(
    { tenantId: input.tenantId, wabaId: input.wabaId, tokenPrint: fingerprint(input.accessToken) },
    'manual connection requested'
  );

  // Validate before writing anything. Embedded Signup hands us a token Meta
  // has just issued, so it is known good; a hand-entered one is the most
  // likely thing to be wrong, and a mistyped token should produce a sentence
  // the user can act on rather than a half-created connection.
  try {
    await graph.getWabaDetails(input.wabaId, input.accessToken);
  } catch (error) {
    if (error instanceof GraphApiError && error.isAuthFailure) {
      throw new Error(
        'Meta rejected that access token. Check it was copied in full and has not expired — ' +
          'tokens generated in the API Setup panel last 24 hours.'
      );
    }
    if (error instanceof GraphApiError && error.isMissingAdvancedAccess) {
      throw new Error(
        'The token is valid but cannot read that WhatsApp Business Account. Check the account ID, ' +
          'and that the token belongs to a user or system user with access to it.'
      );
    }
    throw new Error(`Could not reach that WhatsApp Business Account: ${describeFailure(error)}`);
  }

  return connectWithToken(input);
}

async function connectWithToken(input: ManualConnectInput): Promise<OnboardingResult> {
  const warnings: string[] = [];
  const token = input.accessToken;
  const tokenPrint = fingerprint(token);

  // Record the connection before the remaining calls, so a failure half way
  // leaves a row an operator can see and retry rather than nothing at all.
  const connection = await queryOne<{ id: string }>(
    `INSERT INTO wa_connections
       (tenant_id, waba_id, access_token_encrypted, token_fingerprint, status, onboarded_by)
     VALUES ($1, $2, $3, $4, 'PENDING', $5)
     ON CONFLICT (waba_id) DO UPDATE
       SET access_token_encrypted = EXCLUDED.access_token_encrypted,
           token_fingerprint      = EXCLUDED.token_fingerprint,
           status                 = 'PENDING',
           error_detail           = NULL
     RETURNING id`,
    [input.tenantId, input.wabaId, encryptSecret(token), tokenPrint, input.onboardedBy ?? null]
  );

  const connectionId = connection!.id;

  try {
    // Step 2 — register for Cloud API.
    try {
      await graph.registerPhoneNumber(input.phoneNumberId, token, env.metaRegistrationPin);
    } catch (error) {
      if (isAlreadyRegistered(error)) {
        warnings.push('Number was already registered (coexistence onboarding); registration skipped.');
      } else {
        throw error;
      }
    }

    // Step 3 — subscribe to webhooks. Explicitly fatal: a connection that is
    // not subscribed receives nothing, and reporting it as healthy would be a
    // lie the tenant only discovers when a customer's message disappears.
    await graph.subscribeApp(input.wabaId, token);

    // Step 4 — read back what actually exists.
    const [details, numbers] = await Promise.all([
      graph.getWabaDetails(input.wabaId, token).catch((error: unknown) => {
        warnings.push(`Could not read account details: ${(error as Error).message}`);
        return null;
      }),
      graph.listPhoneNumbers(input.wabaId, token),
    ]);

    const stored = await withTransaction(async (client) => {
      await client.query(
        `UPDATE wa_connections
            SET business_id   = $2,
                business_name = $3,
                status        = 'ACTIVE',
                error_detail  = NULL,
                subscribed_at = NOW()
          WHERE id = $1`,
        [connectionId, details?.owner_business_info?.id ?? null, details?.owner_business_info?.name ?? details?.name ?? null]
      );

      const rows: OnboardingResult['numbers'] = [];

      for (const number of numbers) {
        const isOnboardedNumber = number.id === input.phoneNumberId;

        const row = await client.query<{ id: string }>(
          `INSERT INTO wa_numbers
             (tenant_id, connection_id, phone_number_id, display_number, verified_name,
              quality_rating, registered, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (phone_number_id) DO UPDATE
             SET display_number = EXCLUDED.display_number,
                 verified_name  = EXCLUDED.verified_name,
                 quality_rating = EXCLUDED.quality_rating,
                 registered     = EXCLUDED.registered OR wa_numbers.registered
           RETURNING id`,
          [
            input.tenantId,
            connectionId,
            number.id,
            number.display_phone_number,
            number.verified_name ?? null,
            number.quality_rating ?? null,
            isOnboardedNumber,
            false,
          ]
        );

        rows.push({
          id: row.rows[0].id,
          phoneNumberId: number.id,
          displayNumber: number.display_phone_number,
          registered: isOnboardedNumber,
        });
      }

      // Promote a default only when the tenant has none, so re-running
      // onboarding never silently moves where their messages are sent from.
      await client.query(
        `UPDATE wa_numbers SET is_default = TRUE
          WHERE id = (
            SELECT n.id FROM wa_numbers n
             WHERE n.tenant_id = $1
               AND NOT EXISTS (SELECT 1 FROM wa_numbers d WHERE d.tenant_id = $1 AND d.is_default)
             ORDER BY n.created_at
             LIMIT 1
          )`,
        [input.tenantId]
      );

      return rows;
    });

    if (stored.length === 0) {
      warnings.push('Meta reported no phone numbers on this account yet; add one in WhatsApp Manager.');
    }

    log.info({ connectionId, numbers: stored.length }, 'onboarding complete');

    return { connectionId, status: 'ACTIVE', numbers: stored, warnings };
  } catch (error) {
    const detail = describeFailure(error);

    await query(`UPDATE wa_connections SET status = 'ERROR', error_detail = $2 WHERE id = $1`, [
      connectionId,
      detail.slice(0, 500),
    ]);

    log.error({ connectionId, err: detail }, 'onboarding failed');
    throw error;
  }
}

/**
 * Turns a Graph failure into something an operator can act on.
 *
 * Meta's "Permissions error" for code 200 is the single most misleading
 * message in the whole integration — it means App Review has not granted
 * Advanced access — so it is translated rather than passed through.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof GraphApiError) {
    if (error.isMissingAdvancedAccess) {
      return (
        `Meta refused the call with code ${error.code}. This normally means the app does not yet have ` +
        'Advanced access to whatsapp_business_management, which App Review must grant before customer ' +
        'accounts can be managed.'
      );
    }
    if (error.isAuthFailure) {
      return `The access token was rejected (code ${error.code}). Re-run onboarding for this account.`;
    }
    return `Meta returned ${error.status}: ${error.message}`;
  }
  return (error as Error).message;
}

// --- reading connections ----------------------------------------------------

export async function listConnections(tenantId: string): Promise<ConnectionRecord[]> {
  return query<ConnectionRecord>(
    `SELECT id, tenant_id, waba_id, waac_id, business_id, business_name,
            status, error_detail, token_fingerprint, subscribed_at, created_at
       FROM wa_connections
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantId]
  );
}

export interface TenantNumber {
  id: string;
  phone_number_id: string;
  display_number: string;
  verified_name: string | null;
  quality_rating: string | null;
  registered: boolean;
  is_default: boolean;
  connection_status: string;
}

export async function listNumbers(tenantId: string): Promise<TenantNumber[]> {
  return query<TenantNumber>(
    `SELECT n.id, n.phone_number_id, n.display_number, n.verified_name,
            n.quality_rating, n.registered, n.is_default,
            c.status::TEXT AS connection_status
       FROM wa_numbers n
       JOIN wa_connections c ON c.id = n.connection_id
      WHERE n.tenant_id = $1
      ORDER BY n.is_default DESC, n.created_at`,
    [tenantId]
  );
}

/**
 * The credentials needed to send as a tenant.
 *
 * Returns the decrypted token, so callers must never log the result. It is a
 * function rather than a cached value because a token can be replaced by
 * re-onboarding at any time.
 */
export interface SendingIdentity {
  phoneNumberId: string;
  token: string;
  numberId: string;
  wabaId: string;
  connectionId: string;
}

export async function sendingIdentity(
  tenantId: string,
  numberId?: string | null
): Promise<SendingIdentity | null> {
  const row = await queryOne<{
    number_id: string;
    phone_number_id: string;
    access_token_encrypted: string;
    waba_id: string;
    connection_id: string;
  }>(
    `SELECT n.id AS number_id, n.phone_number_id, c.access_token_encrypted, c.waba_id, c.id AS connection_id
       FROM wa_numbers n
       JOIN wa_connections c ON c.id = n.connection_id
      WHERE n.tenant_id = $1
        AND c.status = 'ACTIVE'
        AND ($2::UUID IS NULL OR n.id = $2)
      ORDER BY n.is_default DESC, n.created_at
      LIMIT 1`,
    [tenantId, numberId ?? null]
  );

  if (!row) return null;

  return {
    numberId: row.number_id,
    phoneNumberId: row.phone_number_id,
    token: decryptSecret(row.access_token_encrypted),
    wabaId: row.waba_id,
    connectionId: row.connection_id,
  };
}

/** Routing: which tenant owns the number a webhook arrived on. */
export interface NumberRoute {
  tenantId: string;
  numberId: string;
  phoneNumberId: string;
  helpdeskEnabled: boolean;
  tenantStatus: 'ACTIVE' | 'SUSPENDED';
}

export async function routeByPhoneNumberId(phoneNumberId: string): Promise<NumberRoute | null> {
  const row = await queryOne<{
    tenant_id: string;
    number_id: string;
    helpdesk_enabled: boolean;
    tenant_status: 'ACTIVE' | 'SUSPENDED';
  }>(
    `SELECT n.tenant_id, n.id AS number_id, t.helpdesk_enabled, t.status::TEXT AS tenant_status
       FROM wa_numbers n
       JOIN tenants t ON t.id = n.tenant_id
      WHERE n.phone_number_id = $1`,
    [phoneNumberId]
  );

  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    numberId: row.number_id,
    phoneNumberId,
    helpdeskEnabled: row.helpdesk_enabled,
    tenantStatus: row.tenant_status,
  };
}

/** Disconnects an account: the token is destroyed, the history is kept. */
export async function disconnect(tenantId: string, connectionId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE wa_connections
        SET status = 'DISCONNECTED',
            access_token_encrypted = '',
            error_detail = 'Disconnected by the tenant.'
      WHERE id = $1 AND tenant_id = $2
      RETURNING id`,
    [connectionId, tenantId]
  );
  return row !== null;
}
