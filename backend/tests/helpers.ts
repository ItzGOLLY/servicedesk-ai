import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { pool, query } from '../src/db/pool';
import { hashPassword } from '../src/utils/security';
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
      whatsapp_messages, ai_suggestions, ticket_events, ticket_messages,
      notifications, audit_logs, tickets, categories, users
    RESTART IDENTITY CASCADE
  `);
  await pool.query('ALTER SEQUENCE ticket_reference_seq RESTART WITH 1000');
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
  password = 'Password123'
): Promise<TestUser> {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4::user_role) RETURNING id`,
    [email, await hashPassword(password), fullName, role]
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

export async function createCategory(name = 'Billing'): Promise<string> {
  const rows = await query<{ id: string }>(
    'INSERT INTO categories (name) VALUES ($1) RETURNING id',
    [name]
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
