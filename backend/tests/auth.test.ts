import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app, createUser, migrateTestDatabase, resetDatabase } from './helpers';
import { closePool, query } from '../src/db/pool';

describe('Authentication', () => {
  beforeAll(async () => {
    await migrateTestDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('registers a new customer and returns an access token', async () => {
    const response = await request(app).post('/api/auth/register').send({
      fullName: 'Rohan Menon',
      email: 'rohan@example.com',
      password: 'Password123',
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe('rohan@example.com');
    expect(response.body.data.accessToken).toBeTruthy();
  });

  it('always assigns the CUSTOMER role on self-registration', async () => {
    // A caller trying to escalate by passing a role must not succeed.
    const response = await request(app).post('/api/auth/register').send({
      fullName: 'Sneaky User',
      email: 'sneaky@example.com',
      password: 'Password123',
      role: 'ADMIN',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe('CUSTOMER');
  });

  it('never stores the password in plaintext', async () => {
    await request(app).post('/api/auth/register').send({
      fullName: 'Rohan Menon',
      email: 'rohan@example.com',
      password: 'Password123',
    });

    const rows = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      ['rohan@example.com']
    );

    expect(rows[0].password_hash).not.toBe('Password123');
    expect(rows[0].password_hash.startsWith('$2')).toBe(true); // bcrypt prefix
  });

  it('rejects a weak password with a field-level message', async () => {
    const response = await request(app).post('/api/auth/register').send({
      fullName: 'Weak Password',
      email: 'weak@example.com',
      password: 'abc',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.details.some((d: { field: string }) => d.field === 'password')).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    const payload = {
      fullName: 'Rohan Menon',
      email: 'rohan@example.com',
      password: 'Password123',
    };
    await request(app).post('/api/auth/register').send(payload);
    const second = await request(app).post('/api/auth/register').send(payload);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('logs in with correct credentials', async () => {
    await createUser('CUSTOMER', 'rohan@example.com');

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohan@example.com', password: 'Password123' });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTruthy();
  });

  it('rejects an incorrect password with 401', async () => {
    await createUser('CUSTOMER', 'rohan@example.com');

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohan@example.com', password: 'WrongPassword1' });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid email or password.');
  });

  it('gives an identical message for unknown and wrong-password logins', async () => {
    await createUser('CUSTOMER', 'rohan@example.com');

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohan@example.com', password: 'WrongPassword1' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'WrongPassword1' });

    // Identical responses prevent account enumeration.
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('refuses login for a deactivated account', async () => {
    const user = await createUser('CUSTOMER', 'rohan@example.com');
    await query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohan@example.com', password: 'Password123' });

    expect(response.status).toBe(403);
  });

  it('rejects a protected route without a token', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed or forged token', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(response.status).toBe(401);
  });

  it('returns the current user for a valid token', async () => {
    const user = await createUser('AGENT', 'priya@example.com', 'Priya Nair');

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe('priya@example.com');
    expect(response.body.data.user.role).toBe('AGENT');
  });

  it('stops honouring a token once the account is deactivated', async () => {
    const user = await createUser('CUSTOMER', 'rohan@example.com');
    await query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);

    // The token is still cryptographically valid, but the user row is re-read
    // on every request, so deactivation takes effect immediately.
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(response.status).toBe(403);
  });
});
