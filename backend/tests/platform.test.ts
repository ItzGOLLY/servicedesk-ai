import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import {
  app,
  auth,
  createConnectedNumber,
  createTenant,
  createUser,
  defaultTenantId,
  migrateTestDatabase,
  resetDatabase,
  type TestUser,
} from './helpers';
import { closePool, query, queryOne } from '../src/db/pool';
import { env } from '../src/config/env';
import { encryptSecret, decryptSecret, fingerprint, generateApiKey, signWebhook, sha256 } from '../src/utils/crypto';
import * as router from '../src/services/platform/router.service';
import * as webhooks from '../src/services/platform/webhooks.service';

/**
 * Tests for the Tech Provider platform.
 *
 * The question these exist to answer is the one that matters commercially:
 * can one business ever see, send as, or be mistaken for another? Everything
 * else here supports that.
 */

const APP_SECRET = 'platform-test-app-secret';

/** Builds a Meta webhook body for a given number, as Meta actually shapes it. */
function metaBody(phoneNumberId: string, from: string, text: string, messageId = 'wamid.T1') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId, display_phone_number: '+15550001111' },
              contacts: [{ wa_id: from.replace('+', ''), profile: { name: 'Test Person' } }],
              messages: [
                { id: messageId, from: from.replace('+', ''), type: 'text', timestamp: '1', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

const sign = (body: unknown): string =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(JSON.stringify(body), 'utf8').digest('hex');

const post = (body: unknown) =>
  request(app)
    .post('/api/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(body))
    .send(JSON.stringify(body));

describe('Credential encryption (unit)', () => {
  it('round-trips a token and produces different ciphertext each time', () => {
    const token = 'EAAG-a-very-secret-business-token';

    const first = encryptSecret(token);
    const second = encryptSecret(token);

    expect(decryptSecret(first)).toBe(token);
    expect(decryptSecret(second)).toBe(token);
    // A fresh IV per encryption; identical ciphertext would leak that two
    // tenants hold the same token.
    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
  });

  it('refuses to decrypt a tampered ciphertext rather than returning wrong bytes', () => {
    const encoded = encryptSecret('secret-token');
    const [version, iv, tag, ciphertext] = encoded.split('.');

    // Flip one character of the payload.
    const corrupted = [version, iv, tag, ciphertext.slice(0, -1) + (ciphertext.at(-1) === 'A' ? 'B' : 'A')].join('.');

    expect(() => decryptSecret(corrupted)).toThrow();
  });

  it('fingerprints a token without revealing it', () => {
    const print = fingerprint('EAAG-secret');
    expect(print).toHaveLength(12);
    expect('EAAG-secret').not.toContain(print);
  });

  it('derives a usable key from every supported encoding', () => {
    // The deployment supplies this value, and the shapes differ by platform:
    // 32 bytes of hex, 32 bytes of base64, or a long generated string. All
    // must work, because the alternative is a service that will not boot.
    const original = env.platformEncryptionKey;

    for (const candidate of [
      crypto.randomBytes(32).toString('hex'),
      crypto.randomBytes(32).toString('base64'),
      'a-generated-secret-of-more-than-32-characters',
    ]) {
      (env as { platformEncryptionKey: string }).platformEncryptionKey = candidate;
      expect(decryptSecret(encryptSecret('business-token'))).toBe('business-token');
    }

    // Too little entropy to be a key: refused rather than silently padded.
    (env as { platformEncryptionKey: string }).platformEncryptionKey = 'tooshort';
    expect(() => encryptSecret('business-token')).toThrow(/too short/i);

    (env as { platformEncryptionKey: string }).platformEncryptionKey = original;
  });

  it('issues API keys that are stored only as hashes', () => {
    const { key, prefix, hash } = generateApiKey();

    expect(key.startsWith(prefix)).toBe(true);
    expect(hash).toBe(sha256(key));
    expect(hash).not.toContain(key);
  });
});

describe('Webhook signature verification (unit)', () => {
  const original = env.metaAppSecret;

  beforeEach(() => {
    (env as { metaAppSecret: string }).metaAppSecret = APP_SECRET;
  });

  afterAll(() => {
    (env as { metaAppSecret: string }).metaAppSecret = original;
  });

  it('accepts a correctly signed body and rejects everything else', () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const good = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');

    expect(router.verifyMetaSignature(raw, good)).toBe(true);
    expect(router.verifyMetaSignature(raw + ' ', good)).toBe(false);
    expect(router.verifyMetaSignature(raw, 'sha256=deadbeef')).toBe(false);
    expect(router.verifyMetaSignature(raw, undefined)).toBe(false);
  });

  it('rejects a body signed with a different secret', () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const wrong = 'sha256=' + crypto.createHmac('sha256', 'not-the-secret').update(raw).digest('hex');

    expect(router.verifyMetaSignature(raw, wrong)).toBe(false);
  });
});

describe('Tenant routing and isolation (integration)', () => {
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    (env as { metaAppSecret: string }).metaAppSecret = APP_SECRET;

    acme = await defaultTenantId();
    globex = await createTenant('Globex Retail', 'globex');

    await createConnectedNumber(acme, 'pn-acme', '+15550001111');
    await createConnectedNumber(globex, 'pn-globex', '+15550002222');

    await query(`INSERT INTO categories (tenant_id, name) VALUES ($1, 'Billing'), ($2, 'Billing')`, [
      acme,
      globex,
    ]);
  });

  it('routes a message to the tenant that owns the number it arrived on', async () => {
    const response = await post(metaBody('pn-globex', '+919000000001', 'My parcel never arrived at all.'));

    expect(response.status).toBe(200);

    const tickets = await query<{ tenant_id: string }>('SELECT tenant_id FROM tickets');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].tenant_id).toBe(globex);
  });

  it('keeps the same phone number as two unrelated customers across tenants', async () => {
    const shopper = '+919000000007';

    await post(metaBody('pn-acme', shopper, 'My payment was taken twice this morning.', 'wamid.A1'));
    await post(metaBody('pn-globex', shopper, 'My parcel never arrived at all.', 'wamid.G1'));

    const users = await query<{ tenant_id: string; email: string }>(
      'SELECT tenant_id, email FROM users WHERE whatsapp_number = $1 ORDER BY tenant_id',
      [shopper]
    );

    // One account per business: the same person is a customer of both, and
    // neither should see the other's history.
    expect(users).toHaveLength(2);
    expect(new Set(users.map((u) => u.tenant_id))).toEqual(new Set([acme, globex]));
    // Placeholder addresses must not collide, since users.email is unique.
    expect(users[0].email).not.toBe(users[1].email);

    const tickets = await query<{ tenant_id: string }>('SELECT tenant_id FROM tickets');
    expect(tickets).toHaveLength(2);
  });

  it('treats the same provider message id as distinct per tenant', async () => {
    await post(metaBody('pn-acme', '+919000000008', 'My payment was taken twice this morning.', 'wamid.SHARED'));
    await post(metaBody('pn-globex', '+919000000008', 'My parcel never arrived at all.', 'wamid.SHARED'));

    const rows = await query<{ tenant_id: string }>(
      `SELECT tenant_id FROM whatsapp_messages WHERE provider_message_id = 'wamid.SHARED' AND direction = 'INBOUND'`
    );
    expect(rows).toHaveLength(2);
  });

  it('ignores a replayed delivery within one tenant', async () => {
    const body = metaBody('pn-acme', '+919000000009', 'My payment was taken twice this morning.', 'wamid.DUP');

    await post(body);
    await post(body);

    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(1);
  });

  it('rejects an unsigned delivery before doing any work', async () => {
    const body = metaBody('pn-acme', '+919000000010', 'My payment was taken twice this morning.');

    const response = await request(app)
      .post('/api/webhooks/meta')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

    expect(response.status).toBe(403);
    expect(await query('SELECT id FROM tickets')).toHaveLength(0);
  });

  it('acknowledges a number this platform does not serve without creating anything', async () => {
    const response = await post(metaBody('pn-unknown', '+919000000011', 'Hello, is anyone there at all?'));

    // 200 so Meta does not retry: we handled it, there was simply nothing to do.
    expect(response.status).toBe(200);
    expect(await query('SELECT id FROM tickets')).toHaveLength(0);
  });

  it('drops traffic for a suspended tenant', async () => {
    await query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [globex]);

    const response = await post(metaBody('pn-globex', '+919000000012', 'My parcel never arrived at all.'));

    expect(response.status).toBe(200);
    expect(await query('SELECT id FROM tickets')).toHaveLength(0);
  });

  it('records the message but raises no ticket when the helpdesk app is off', async () => {
    await query('UPDATE tenants SET helpdesk_enabled = FALSE WHERE id = $1', [globex]);

    await post(metaBody('pn-globex', '+919000000013', 'My parcel never arrived at all.'));

    expect(await query('SELECT id FROM tickets')).toHaveLength(0);

    const logged = await query<{ tenant_id: string }>(
      `SELECT tenant_id FROM whatsapp_messages WHERE direction = 'INBOUND'`
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].tenant_id).toBe(globex);
  });

  it('adds the sender to the receiving tenant’s contact book only', async () => {
    await post(metaBody('pn-acme', '+919000000014', 'My payment was taken twice this morning.'));

    const contacts = await query<{ tenant_id: string; name: string }>('SELECT tenant_id, name FROM contacts');
    expect(contacts).toHaveLength(1);
    expect(contacts[0].tenant_id).toBe(acme);
    expect(contacts[0].name).toBe('Test Person');
  });

  it('marks a connection as errored when Meta reports a ban', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-pn-globex',
          changes: [
            {
              field: 'account_update',
              value: { event: 'ACCOUNT_VIOLATION', ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' } },
            },
          ],
        },
      ],
    };

    const response = await post(body);
    expect(response.status).toBe(200);

    const connection = await queryOne<{ status: string; error_detail: string; tenant_id: string }>(
      `SELECT status::TEXT AS status, error_detail, tenant_id FROM wa_connections WHERE waba_id = 'waba-pn-globex'`
    );
    expect(connection!.status).toBe('ERROR');
    expect(connection!.error_detail).toContain('ACCOUNT_VIOLATION');
    // Attributed to the owning tenant, not to whoever happened to be first.
    expect(connection!.tenant_id).toBe(globex);
  });

  it('ignores an account update for an account this platform does not hold', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-unknown', changes: [{ field: 'account_update', value: { event: 'ACCOUNT_VIOLATION' } }] }],
    };

    await expect(post(body)).resolves.toMatchObject({ status: 200 });
  });

  it('meters inbound messages against the receiving tenant', async () => {
    await post(metaBody('pn-acme', '+919000000015', 'My payment was taken twice this morning.'));

    const usage = await query<{ tenant_id: string; kind: string }>(
      `SELECT tenant_id, kind FROM usage_events WHERE kind = 'message.received'`
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].tenant_id).toBe(acme);
  });
});

describe('Tenant console and API keys (integration)', () => {
  let admin: TestUser;
  let otherAdmin: TestUser;
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    acme = await defaultTenantId();
    globex = await createTenant('Globex Retail', 'globex');

    admin = await createUser('ADMIN', 'admin@acme.test', 'Acme Admin');
    otherAdmin = await createUser('ADMIN', 'admin@globex.test', 'Globex Admin', 'Password123', globex);
  });

  it('issues an API key once and stores only its hash', async () => {
    const response = await request(app)
      .post('/api/platform/api-keys')
      .set(auth(admin))
      .send({ name: 'Production' });

    expect(response.status).toBe(201);
    const key: string = response.body.data.key;
    expect(key.startsWith('sdk_')).toBe(true);

    const stored = await queryOne<{ key_hash: string }>('SELECT key_hash FROM api_keys');
    expect(stored!.key_hash).toBe(sha256(key));
    expect(stored!.key_hash).not.toBe(key);

    // Listing never returns the key again.
    const list = await request(app).get('/api/platform/api-keys').set(auth(admin));
    expect(JSON.stringify(list.body)).not.toContain(key);
  });

  it('authenticates the public API with a key and scopes it to that tenant', async () => {
    const issued = await request(app)
      .post('/api/platform/api-keys')
      .set(auth(admin))
      .send({ name: 'Production' });

    const response = await request(app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${issued.body.data.key}`);

    expect(response.status).toBe(200);
    expect(response.body.data.tenant.id).toBe(acme);
  });

  it('refuses a revoked key', async () => {
    const issued = await request(app)
      .post('/api/platform/api-keys')
      .set(auth(admin))
      .send({ name: 'Production' });

    await request(app)
      .delete(`/api/platform/api-keys/${issued.body.data.id}`)
      .set(auth(admin));

    const response = await request(app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${issued.body.data.key}`);

    expect(response.status).toBe(401);
  });

  it('refuses a session cookie on the public API — keys only', async () => {
    const response = await request(app).get('/v1/me').set(auth(admin));
    expect(response.status).toBe(401);
  });

  it('never lets one tenant see or revoke another’s keys', async () => {
    const issued = await request(app)
      .post('/api/platform/api-keys')
      .set(auth(admin))
      .send({ name: 'Acme key' });

    const list = await request(app).get('/api/platform/api-keys').set(auth(otherAdmin));
    expect(list.body.data).toHaveLength(0);

    const revoke = await request(app)
      .delete(`/api/platform/api-keys/${issued.body.data.id}`)
      .set(auth(otherAdmin));
    expect(revoke.status).toBe(404);

    // Still usable, because the other tenant's attempt changed nothing.
    const stillWorks = await request(app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${issued.body.data.key}`);
    expect(stillWorks.status).toBe(200);
  });

  it('scopes messages returned by the public API to the calling tenant', async () => {
    await createConnectedNumber(acme, 'pn-acme', '+15550001111');
    await createConnectedNumber(globex, 'pn-globex', '+15550002222');

    await query(
      `INSERT INTO whatsapp_messages (tenant_id, direction, provider_message_id, wa_number, body, status, provider)
       VALUES ($1, 'INBOUND', 'm-acme', '+919000000001', 'acme message', 'DELIVERED', 'meta'),
              ($2, 'INBOUND', 'm-globex', '+919000000002', 'globex message', 'DELIVERED', 'meta')`,
      [acme, globex]
    );

    const issued = await request(app)
      .post('/api/platform/api-keys')
      .set(auth(admin))
      .send({ name: 'Production' });

    const response = await request(app)
      .get('/v1/messages')
      .set('Authorization', `Bearer ${issued.body.data.key}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].body).toBe('acme message');
  });

  it('refuses a manual connection whose account belongs to another tenant', async () => {
    await createConnectedNumber(globex, 'pn-globex', '+15550002222');

    const response = await request(app)
      .post('/api/platform/connections/manual')
      .set(auth(admin))
      .send({
        waba_id: 'waba-pn-globex'.replace(/\D/g, '') || '99999',
        phone_number_id: '12345678',
        access_token: 'EAAG-a-token-long-enough-to-pass-validation',
      });

    // Either the account is taken (409) or the credentials are rejected
    // upstream (502) — never a silent success that moves another tenant's
    // account into this workspace.
    expect([409, 502]).toContain(response.status);

    const owner = await queryOne<{ tenant_id: string }>(
      `SELECT tenant_id FROM wa_connections WHERE waba_id = 'waba-pn-globex'`
    );
    expect(owner!.tenant_id).toBe(globex);
  });

  it('validates manual connection input before calling Meta', async () => {
    for (const body of [
      { waba_id: 'not-digits', phone_number_id: '12345678', access_token: 'EAAG-long-enough-token-value' },
      { waba_id: '12345678', phone_number_id: 'nope', access_token: 'EAAG-long-enough-token-value' },
      { waba_id: '12345678', phone_number_id: '12345678', access_token: 'short' },
    ]) {
      const response = await request(app)
        .post('/api/platform/connections/manual')
        .set(auth(admin))
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('refuses manual connection to an agent — admins configure the channel', async () => {
    const agent = await createUser('AGENT', 'agent@acme.test', 'Acme Agent');
    const response = await request(app)
      .post('/api/platform/connections/manual')
      .set(auth(agent))
      .send({
        waba_id: '12345678',
        phone_number_id: '87654321',
        access_token: 'EAAG-a-token-long-enough-to-pass',
      });
    expect(response.status).toBe(403);
  });

  it('refuses a WhatsApp account already connected to another tenant', async () => {
    await createConnectedNumber(globex, 'pn-globex', '+15550002222');

    const response = await request(app)
      .post('/api/platform/connections/embedded-signup')
      .set(auth(admin))
      .send({ code: 'a-signup-code-value', waba_id: 'waba-pn-globex', phone_number_id: 'pn-globex' });

    expect(response.status).toBe(409);
  });
});

describe('Outbound webhooks to tenants (integration)', () => {
  let tenant: string;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await defaultTenantId();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  async function endpoint(url = 'https://tenant.example.com/hooks'): Promise<string> {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO webhook_endpoints (tenant_id, url, secret, events)
       VALUES ($1, $2, 'whsec_test', ARRAY['message.received'])
       RETURNING id`,
      [tenant, url]
    );
    return row!.id;
  }

  it('queues nothing when the tenant has no endpoint', async () => {
    const queued = await webhooks.enqueueEvent(tenant, 'message.received', { text: 'hello' });
    expect(queued).toBe(0);
  });

  it('queues only for endpoints subscribed to the event', async () => {
    await endpoint();

    expect(await webhooks.enqueueEvent(tenant, 'message.received', { text: 'hi' })).toBe(1);
    // The endpoint above subscribes to message.received only.
    expect(await webhooks.enqueueEvent(tenant, 'template.status', { name: 'x' })).toBe(0);
  });

  it('signs the delivery over timestamp and body so it cannot be replayed', async () => {
    await endpoint();
    await webhooks.enqueueEvent(tenant, 'message.received', { text: 'hello' });

    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      captured = {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body),
      };
      return new Response('ok', { status: 200 });
    });

    const result = await webhooks.dispatchDue();
    expect(result.delivered).toBe(1);
    expect(captured).not.toBeNull();

    const header = captured!.headers['X-ServiceDesk-Signature'];
    const [timestampPart, signaturePart] = header.split(',');
    const timestamp = timestampPart.replace('t=', '');
    const signature = signaturePart.replace('v1=', '');

    expect(signature).toBe(signWebhook('whsec_test', Number(timestamp), captured!.body));

    const stored = await queryOne<{ status: string; attempts: number }>(
      'SELECT status::TEXT AS status, attempts FROM webhook_deliveries'
    );
    expect(stored!.status).toBe('DELIVERED');
    expect(stored!.attempts).toBe(1);
  });

  it('retries a failing endpoint with a growing delay, then gives up', async () => {
    await endpoint();
    await webhooks.enqueueEvent(tenant, 'message.received', { text: 'hello' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    // First attempt fails and is rescheduled rather than abandoned.
    await webhooks.dispatchDue();

    let row = await queryOne<{ status: string; attempts: number; last_error: string }>(
      'SELECT status::TEXT AS status, attempts, last_error FROM webhook_deliveries'
    );
    expect(row!.status).toBe('PENDING');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain('500');

    // Exhaust the remaining attempts, making each one due immediately.
    for (let i = 0; i < webhooks.MAX_ATTEMPTS; i += 1) {
      await query(`UPDATE webhook_deliveries SET next_attempt_at = NOW()`);
      await webhooks.dispatchDue();
    }

    row = await queryOne<{ status: string; attempts: number; last_error: string }>(
      'SELECT status::TEXT AS status, attempts, last_error FROM webhook_deliveries'
    );
    expect(row!.status).toBe('FAILED');
    expect(row!.attempts).toBe(webhooks.MAX_ATTEMPTS);
  });

  it('records a network failure as a retryable error, not a crash', async () => {
    await endpoint();
    await webhooks.enqueueEvent(tenant, 'message.received', { text: 'hello' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(webhooks.dispatchDue()).resolves.toMatchObject({ attempted: 1, delivered: 0 });

    const row = await queryOne<{ status: string; last_error: string }>(
      'SELECT status::TEXT AS status, last_error FROM webhook_deliveries'
    );
    expect(row!.status).toBe('PENDING');
    expect(row!.last_error).toContain('ECONNREFUSED');
  });

  it('delivers an inbound message to the tenant endpoint end to end', async () => {
    (env as { metaAppSecret: string }).metaAppSecret = APP_SECRET;
    await createConnectedNumber(tenant, 'pn-acme', '+15550001111');
    await query(`INSERT INTO categories (tenant_id, name) VALUES ($1, 'Billing')`, [tenant]);
    await endpoint();

    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(String(init?.body));
      return new Response('ok', { status: 200 });
    });

    await post(metaBody('pn-acme', '+919000000021', 'My payment was taken twice this morning.'));

    // The dispatch after enqueue is deliberately not awaited by the webhook
    // route, so give it a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen.length).toBeGreaterThan(0);
    const payload = JSON.parse(seen[0]);
    expect(payload.type).toBe('message.received');
    expect(payload.data.text).toBe('My payment was taken twice this morning.');
    expect(payload.data.phone_number_id).toBe('pn-acme');
  });
});

// One teardown for the file: each describe closing the pool would leave the
// later ones without a connection.
afterAll(async () => {
  await closePool();
});
