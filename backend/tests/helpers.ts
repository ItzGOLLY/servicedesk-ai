import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { pool, query } from '../src/db/pool';
import { encryptSecret } from '../src/utils/crypto';
import { hashPassword } from '../src/utils/security';
import { resetTenantCache } from '../src/services/platform/tenant.service';
import type { UserRole } from '../src/types';

export const app: Express = createApp();

/** Applies the real migration files, so tests run against the production schema. */
export async function migrateTestDatabase(): Promise<void> {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
}

/**
 * Empties every table between tests.
 * TRUNCATE ... CASCADE also resets the sequences, so ticket references restart
 * predictably and assertions do not depend on execution order.
 */
export async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      kb_retrievals, kb_chunks, kb_articles,
      usage_events, webhook_deliveries, webhook_endpoints, api_keys,
      broadcast_recipients, broadcasts, message_templates, contacts,
      whatsapp_messages, wa_numbers, wa_connections,
      ai_suggestions, ticket_events, ticket_messages,
      notifications, audit_logs, tickets, categories, users, tenants
    RESTART IDENTITY CASCADE
  `);
  await pool.query('ALTER SEQUENCE ticket_reference_seq RESTART WITH 1000');

  // Truncating tenants removes the one migration 006 seeded, so the default
  // workspace is recreated. Without it, registration and the first-party
  // WhatsApp path would have no tenant to attach rows to.
  await pool.query(
    `INSERT INTO tenants (name, slug) VALUES ('Test Workspace', 'demo')
     ON CONFLICT (slug) DO NOTHING`
  );
  resetTenantCache();
}

/** The workspace every helper creates data in unless told otherwise. */
export async function defaultTenantId(): Promise<string> {
  const rows = await query<{ id: string }>('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
  return rows[0].id;
}

/** A second business, for proving that one tenant cannot see another's data. */
export async function createTenant(name: string, slug: string): Promise<string> {
  const rows = await query<{ id: string }>(
    'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id',
    [name, slug]
  );
  return rows[0].id;
}

/** Registers a connected WhatsApp number so inbound routing has a target. */
export async function createConnectedNumber(
  tenantId: string,
  phoneNumberId: string,
  displayNumber = '+15550001111'
): Promise<{ connectionId: string; numberId: string }> {
  const connection = await query<{ id: string }>(
    `INSERT INTO wa_connections
       (tenant_id, waba_id, access_token_encrypted, token_fingerprint, status, subscribed_at)
     VALUES ($1, $2, $3, 'testfingerprint', 'ACTIVE', NOW())
     RETURNING id`,
    [tenantId, `waba-${phoneNumberId}`, encryptSecret(`token-for-${phoneNumberId}`)]
  );

  const number = await query<{ id: string }>(
    `INSERT INTO wa_numbers
       (tenant_id, connection_id, phone_number_id, display_number, registered, is_default)
     VALUES ($1, $2, $3, $4, TRUE, TRUE)
     RETURNING id`,
    [tenantId, connection[0].id, phoneNumberId, displayNumber]
  );

  return { connectionId: connection[0].id, numberId: number[0].id };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: UserRole;
  token: string;
}

/** Creates a user directly in the database and logs in to obtain a token. */
export async function createUser(
  role: UserRole,
  email: string,
  fullName = 'Test User',
  password = 'Password123',
  tenantId?: string
): Promise<TestUser> {
  const tenant = tenantId ?? (await defaultTenantId());

  const rows = await query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($5, $1, $2, $3, $4::user_role) RETURNING id`,
    [email, await hashPassword(password), fullName, role, tenant]
  );

  const login = await request(app).post('/api/auth/login').send({ email, password });

  return {
    id: rows[0].id,
    email,
    password,
    role,
    token: login.body.data.accessToken,
  };
}

export async function createCategory(name = 'Billing', tenantId?: string): Promise<string> {
  const tenant = tenantId ?? (await defaultTenantId());
  const rows = await query<{ id: string }>(
    'INSERT INTO categories (tenant_id, name) VALUES ($2, $1) RETURNING id',
    [name, tenant]
  );
  return rows[0].id;
}

/** Creates a ticket through the API, so the real validation path is exercised. */
export async function createTicket(
  customer: TestUser,
  subject = 'Payment deducted but order pending',
  description = 'My payment was deducted but my order is still showing as pending. Please help.'
): Promise<{ id: string; reference: string }> {
  const response = await request(app)
    .post('/api/tickets')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({ subject, description });

  return { id: response.body.data.id, reference: response.body.data.reference };
}

export const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });
