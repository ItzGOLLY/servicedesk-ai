import { query, queryOne } from '../../db/pool';
import { signWebhook } from '../../utils/crypto';
import { loggerFor } from '../../observability/logger';

const log = loggerFor('webhooks');

/**
 * Delivery of platform events to each tenant's own endpoint.
 *
 * This is the half of the platform that makes it an integration rather than an
 * application: a tenant's software never polls us, it receives a signed POST
 * the moment something happens, exactly as it would from Twilio.
 *
 * Three properties are deliberate:
 *
 *   - Queued, not inline. A tenant whose server is slow or down must not slow
 *     down the message that Meta is waiting on an acknowledgement for.
 *   - Signed over timestamp + body, so a captured request cannot be replayed.
 *   - Retried with exponential backoff and a hard attempt limit, so a dead
 *     endpoint drains instead of being retried forever.
 */

/** Attempt n waits BACKOFF[n] seconds. Beyond the list, the delivery fails. */
const BACKOFF_SECONDS = [0, 10, 60, 300, 1800];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

const DELIVERY_TIMEOUT_MS = 10_000;

export type PlatformEvent =
  | 'message.received'
  | 'message.sent'
  | 'message.status'
  | 'template.status'
  | 'connection.status';

export interface EventPayload {
  [key: string]: unknown;
}

/**
 * Queues an event for every active endpoint of a tenant that subscribes to it.
 *
 * Returns the number of deliveries created, which is zero when the tenant has
 * no endpoint — a perfectly normal state for a tenant using only the console.
 */
export async function enqueueEvent(
  tenantId: string,
  eventType: PlatformEvent,
  payload: EventPayload
): Promise<number> {
  const endpoints = await query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
      WHERE tenant_id = $1 AND is_active AND $2 = ANY(events)`,
    [tenantId, eventType]
  );

  if (endpoints.length === 0) return 0;

  const body = {
    id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: eventType,
    created_at: new Date().toISOString(),
    data: payload,
  };

  for (const endpoint of endpoints) {
    await query(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [tenantId, endpoint.id, eventType, JSON.stringify(body)]
    );
  }

  return endpoints.length;
}

interface DueDelivery {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_type: string;
  payload: EventPayload;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Sends one delivery and records the outcome.
 *
 * Any 2xx is success. Everything else — including a timeout, a DNS failure or
 * a 500 — is a retryable failure until the attempt limit is reached.
 */
export async function attemptDelivery(delivery: DueDelivery): Promise<boolean> {
  const attempt = delivery.attempts + 1;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(delivery.payload);
  const signature = signWebhook(delivery.secret, timestamp, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  let status: number | null = null;
  let failure: string | null = null;

  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Named after the platform rather than Meta: these are our events,
        // reshaped, not a pass-through of someone else's payload.
        'X-ServiceDesk-Signature': `t=${timestamp},v1=${signature}`,
        'X-ServiceDesk-Event': delivery.event_type,
        'X-ServiceDesk-Delivery': delivery.id,
        'X-ServiceDesk-Attempt': String(attempt),
      },
      body,
    });

    status = response.status;
    if (!response.ok) failure = `Endpoint returned ${response.status}`;
  } catch (error) {
    failure = (error as Error).name === 'AbortError' ? 'Timed out after 10s' : (error as Error).message;
  } finally {
    clearTimeout(timer);
  }

  if (!failure) {
    await query(
      `UPDATE webhook_deliveries
          SET status = 'DELIVERED', attempts = $2, response_status = $3, delivered_at = NOW(), last_error = NULL
        WHERE id = $1`,
      [delivery.id, attempt, status]
    );
    return true;
  }

  const exhausted = attempt >= MAX_ATTEMPTS;

  await query(
    `UPDATE webhook_deliveries
        SET status          = $4::webhook_delivery_status,
            attempts        = $2,
            response_status = $3,
            last_error      = $5,
            next_attempt_at = NOW() + ($6 || ' seconds')::INTERVAL
      WHERE id = $1`,
    [
      delivery.id,
      attempt,
      status,
      exhausted ? 'FAILED' : 'PENDING',
      failure.slice(0, 500),
      exhausted ? 0 : BACKOFF_SECONDS[attempt] ?? 1800,
    ]
  );

  log.warn(
    { deliveryId: delivery.id, attempt, status, exhausted, err: failure },
    'webhook delivery failed'
  );

  return false;
}

/**
 * Sends everything currently due.
 *
 * Called after queuing (so the common case is delivered immediately) and by a
 * periodic sweep (so retries happen even when nothing new arrives). The row
 * lock makes it safe to run on several API instances at once: each delivery is
 * claimed by exactly one of them.
 */
export async function dispatchDue(limit = 20): Promise<{ attempted: number; delivered: number }> {
  const due = await query<DueDelivery>(
    `SELECT d.id, d.tenant_id, d.endpoint_id, d.event_type, d.payload, d.attempts,
            e.url, e.secret
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'PENDING'
        AND d.next_attempt_at <= NOW()
        AND e.is_active
      ORDER BY d.next_attempt_at
      LIMIT $1
      FOR UPDATE OF d SKIP LOCKED`,
    [limit]
  );

  let delivered = 0;
  for (const delivery of due) {
    if (await attemptDelivery(delivery)) delivered += 1;
  }

  return { attempted: due.length, delivered };
}

/**
 * Queues an event and flushes immediately, without making the caller wait.
 *
 * The inbound webhook path uses this: Meta expects a prompt 200, and a tenant's
 * slow endpoint must never be the reason it does not get one.
 */
export async function emit(
  tenantId: string,
  eventType: PlatformEvent,
  payload: EventPayload
): Promise<void> {
  try {
    const queued = await enqueueEvent(tenantId, eventType, payload);
    if (queued > 0) {
      void dispatchDue().catch((error: unknown) => {
        log.error({ err: (error as Error).message }, 'dispatch after enqueue failed');
      });
    }
  } catch (error) {
    // An event that cannot be queued must not break the thing that produced it.
    log.error({ err: (error as Error).message, tenantId, eventType }, 'could not queue event');
  }
}

// --- endpoint management ----------------------------------------------------

export interface EndpointRecord {
  id: string;
  url: string;
  is_active: boolean;
  events: string[];
  created_at: Date;
}

export async function listEndpoints(tenantId: string): Promise<EndpointRecord[]> {
  return query<EndpointRecord>(
    `SELECT id, url, is_active, events, created_at
       FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId]
  );
}

export async function deliveryHistory(
  tenantId: string,
  limit: number,
  offset: number
): Promise<{ rows: unknown[]; total: number }> {
  const rows = await query(
    `SELECT id, event_type, status, attempts, response_status, last_error,
            delivered_at, created_at
       FROM webhook_deliveries
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  const count = await queryOne<{ count: string }>(
    'SELECT COUNT(*)::TEXT AS count FROM webhook_deliveries WHERE tenant_id = $1',
    [tenantId]
  );

  return { rows, total: Number(count?.count ?? 0) };
}
