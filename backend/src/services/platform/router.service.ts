import crypto from 'node:crypto';
import { env } from '../../config/env';
import { query, queryOne } from '../../db/pool';
import { loggerFor } from '../../observability/logger';
import { safeEqual } from '../../utils/crypto';
import * as webhooks from './webhooks.service';
import { routeByPhoneNumberId, type NumberRoute } from './onboarding.service';

const log = loggerFor('router');

/**
 * The multi-tenant inbound path.
 *
 * Every tenant on the platform shares ONE webhook URL, because Meta delivers
 * all of an app's traffic to a single address regardless of how many customer
 * accounts are subscribed. The tenant a message belongs to is therefore not
 * something the request states — it is derived from the phone number the
 * message arrived on, which is why wa_numbers.phone_number_id is unique.
 *
 * Getting this wrong means one business reading another's customer messages,
 * so the lookup is explicit, fails closed, and is covered by tests.
 */

// --- signature --------------------------------------------------------------

/**
 * Verifies Meta's X-Hub-Signature-256 over the raw body.
 *
 * The secret is the PLATFORM app secret, not anything tenant-specific: all
 * deliveries come from our one app. Without this the endpoint would accept
 * forged messages attributed to any tenant's number.
 */
export function verifyMetaSignature(rawBody: string, header: string | undefined): boolean {
  if (!header || !env.metaAppSecret) return false;

  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const expected = crypto.createHmac('sha256', env.metaAppSecret).update(rawBody, 'utf8').digest('hex');

  return safeEqual(expected, provided);
}

// --- payload shapes ---------------------------------------------------------

interface MetaValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<{
    id?: string;
    from?: string;
    type?: string;
    timestamp?: string;
    text?: { body?: string };
  }>;
  statuses?: Array<{
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string }>;
  }>;
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaValue }> }>;
}

/**
 * account_update — Meta's notification about an onboarded account itself.
 *
 * Subscribing to this field is required of a Tech Provider. It is how we learn
 * that a customer finished Embedded Signup, and, more importantly, that one of
 * their numbers was banned, restricted or had its quality downgraded. Without
 * it the first sign of trouble is messages silently failing.
 */
export interface AccountUpdate {
  wabaId: string;
  event: string;
  phoneNumber: string | null;
  reason: string | null;
}

export interface RoutedMessage {
  route: NumberRoute;
  providerMessageId: string;
  from: string;
  body: string;
  profileName: string | null;
  displayPhoneNumber: string | null;
}

export interface RoutedStatus {
  route: NumberRoute;
  providerMessageId: string;
  status: string;
  recipient: string | null;
  error: string | null;
}

export interface RoutingOutcome {
  messages: RoutedMessage[];
  statuses: RoutedStatus[];
  accountUpdates: AccountUpdate[];
  /** Deliveries whose number is not onboarded here, or whose tenant is suspended. */
  unroutable: number;
}

/**
 * Splits one Meta delivery into per-tenant work.
 *
 * A single payload can legitimately carry changes for several accounts, so each
 * change is routed independently rather than assuming the whole body belongs to
 * one tenant.
 */
export async function route(body: unknown): Promise<RoutingOutcome> {
  const payload = body as MetaWebhookBody | undefined;
  const outcome: RoutingOutcome = { messages: [], statuses: [], accountUpdates: [], unroutable: 0 };

  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return outcome;
  }

  // One lookup per distinct number rather than per message.
  const routeCache = new Map<string, NumberRoute | null>();

  const resolve = async (phoneNumberId: string): Promise<NumberRoute | null> => {
    if (!routeCache.has(phoneNumberId)) {
      routeCache.set(phoneNumberId, await routeByPhoneNumberId(phoneNumberId));
    }
    return routeCache.get(phoneNumberId) ?? null;
  };

  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      // account_update arrives keyed by the account (entry.id), not by a
      // phone number, so it is handled before the number-based routing below.
      if (change.field === 'account_update') {
        const update = value as unknown as {
          event?: string;
          phone_number?: string;
          ban_info?: { waba_ban_state?: string };
          restriction_info?: Array<{ restriction_type?: string }>;
        };

        if (entry.id && update.event) {
          outcome.accountUpdates.push({
            wabaId: entry.id,
            event: update.event,
            phoneNumber: update.phone_number ?? null,
            reason:
              update.ban_info?.waba_ban_state ??
              update.restriction_info?.[0]?.restriction_type ??
              null,
          });
        }
        continue;
      }

      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!value || !phoneNumberId) continue;

      const target = await resolve(phoneNumberId);

      if (!target) {
        // Expected during onboarding races and after a disconnect. Logged at
        // info, not error: it is not a fault, and at scale it would be noise.
        log.info({ phoneNumberId }, 'delivery for a number this platform does not serve');
        outcome.unroutable += 1;
        continue;
      }

      if (target.tenantStatus === 'SUSPENDED') {
        log.warn({ tenantId: target.tenantId, phoneNumberId }, 'delivery for a suspended tenant dropped');
        outcome.unroutable += 1;
        continue;
      }

      const profileName = value.contacts?.[0]?.profile?.name ?? null;

      for (const message of value.messages ?? []) {
        // Non-text messages are acknowledged and counted but not processed:
        // the helpdesk flow is text-driven, and silently dropping media would
        // leave a customer waiting for a reply that never comes.
        if (!message.id || !message.from) continue;

        if (message.type !== 'text' || !message.text?.body) {
          log.info({ tenantId: target.tenantId, type: message.type }, 'non-text message received');
          continue;
        }

        outcome.messages.push({
          route: target,
          providerMessageId: message.id,
          from: `+${message.from.replace(/^\+/, '')}`,
          body: message.text.body,
          profileName,
          displayPhoneNumber: value.metadata?.display_phone_number ?? null,
        });
      }

      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;

        outcome.statuses.push({
          route: target,
          providerMessageId: status.id,
          status: status.status,
          recipient: status.recipient_id ? `+${status.recipient_id}` : null,
          error: status.errors?.[0]?.title ?? null,
        });
      }
    }
  }

  return outcome;
}

// --- side effects shared by every tenant ------------------------------------

/**
 * Records the delivery status Meta reports for a message we sent.
 *
 * Only moves a message forward: a 'sent' callback arriving after 'delivered'
 * (which happens, because callbacks are not ordered) must not undo it.
 */
const STATUS_RANK: Record<string, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

export async function applyStatus(update: RoutedStatus): Promise<void> {
  const mapped = update.status.toUpperCase();
  if (!(mapped in STATUS_RANK)) return;

  await query(
    `UPDATE whatsapp_messages
        SET status = $3::wa_delivery_status,
            error_detail = COALESCE($4, error_detail)
      WHERE tenant_id = $1
        AND provider_message_id = $2
        AND CASE status::TEXT
              WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 WHEN 'DELIVERED' THEN 2
              WHEN 'READ' THEN 3 WHEN 'FAILED' THEN 4 ELSE 0 END < $5`,
    [update.route.tenantId, update.providerMessageId, mapped, update.error, STATUS_RANK[mapped]]
  );

  await webhooks.emit(update.route.tenantId, 'message.status', {
    message_id: update.providerMessageId,
    status: mapped.toLowerCase(),
    recipient: update.recipient,
    error: update.error,
  });
}

/**
 * Keeps the tenant's contact book current from inbound traffic.
 *
 * last_inbound_at is what tells a broadcast whether a contact is still inside
 * the 24-hour window in which free-form messages are allowed.
 */
export async function touchContact(
  tenantId: string,
  waNumber: string,
  profileName: string | null
): Promise<void> {
  await queryOne(
    `INSERT INTO contacts (tenant_id, wa_number, name, last_inbound_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, wa_number) DO UPDATE
       SET last_inbound_at = NOW(),
           name = COALESCE(contacts.name, EXCLUDED.name)
     RETURNING id`,
    [tenantId, waNumber, profileName]
  );
}

/**
 * Applies an account_update to the connection it concerns.
 *
 * A ban or a disable is recorded on the connection and surfaced to the tenant,
 * because every send against that account will now fail and the tenant needs
 * to know why rather than discovering it message by message.
 */
export async function applyAccountUpdate(update: AccountUpdate): Promise<void> {
  const connection = await queryOne<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM wa_connections WHERE waba_id = $1',
    [update.wabaId]
  );
  if (!connection) return;

  const disabling = ['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'DISABLED_UPDATE', 'ACCOUNT_DELETED'];
  const isDisabling = disabling.includes(update.event);

  await query(
    `UPDATE wa_connections
        SET status = CASE WHEN $2 THEN 'ERROR'::wa_connection_status ELSE status END,
            error_detail = CASE WHEN $2 THEN $3 ELSE error_detail END
      WHERE id = $1`,
    [
      connection.id,
      isDisabling,
      `Meta reported ${update.event}${update.reason ? ` (${update.reason})` : ''}.`,
    ]
  );

  log.warn(
    { tenantId: connection.tenant_id, event: update.event, disabling: isDisabling },
    'account update received'
  );

  await webhooks.emit(connection.tenant_id, 'connection.status', {
    waba_id: update.wabaId,
    event: update.event,
    phone_number: update.phoneNumber,
    reason: update.reason,
  });
}

/** Append-only metering, used by the analytics endpoints. */
export async function recordUsage(
  tenantId: string,
  kind: string,
  numberId: string | null = null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `INSERT INTO usage_events (tenant_id, kind, number_id, metadata) VALUES ($1, $2, $3, $4)`,
    [tenantId, kind, numberId, JSON.stringify(metadata)]
  );
}
