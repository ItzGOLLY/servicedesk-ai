import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  app,
  auth,
  createTicket,
  createUser,
  migrateTestDatabase,
  resetDatabase,
  type TestUser,
} from './helpers';
import { closePool } from '../src/db/pool';

/**
 * These tests are the evidence that role-based access control is enforced by the
 * API and not merely by hiding buttons in the interface. Every request below is
 * made directly to the backend with a valid token for the wrong role.
 */
describe('Authorization (RBAC)', () => {
  let customer: TestUser;
  let otherCustomer: TestUser;
  let agent: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    customer = await createUser('CUSTOMER', 'rohan@example.com', 'Rohan Menon');
    otherCustomer = await createUser('CUSTOMER', 'sneha@example.com', 'Sneha Iyer');
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
  });

  afterAll(async () => {
    await closePool();
  });

  describe('a customer', () => {
    it('cannot list all users', async () => {
      const response = await request(app).get('/api/users').set(auth(customer));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('cannot create a user', async () => {
      const response = await request(app).post('/api/users').set(auth(customer)).send({
        fullName: 'New Agent',
        email: 'new@example.com',
        password: 'Password123',
        role: 'AGENT',
      });
      expect(response.status).toBe(403);
    });

    it('cannot change anyone’s role', async () => {
      const response = await request(app)
        .patch(`/api/users/${otherCustomer.id}/role`)
        .set(auth(customer))
        .send({ role: 'ADMIN' });
      expect(response.status).toBe(403);
    });

    it('cannot read the audit log', async () => {
      const response = await request(app).get('/api/audit-logs').set(auth(customer));
      expect(response.status).toBe(403);
    });

    it('cannot create a category', async () => {
      const response = await request(app)
        .post('/api/categories')
        .set(auth(customer))
        .send({ name: 'Fake Category' });
      expect(response.status).toBe(403);
    });

    it('cannot open the admin dashboard', async () => {
      const response = await request(app).get('/api/dashboard/admin').set(auth(customer));
      expect(response.status).toBe(403);
    });

    it('cannot read reports', async () => {
      const response = await request(app).get('/api/reports/agent-workload').set(auth(customer));
      expect(response.status).toBe(403);
    });

    it('cannot read another customer’s ticket', async () => {
      const ticket = await createTicket(otherCustomer);

      const response = await request(app).get(`/api/tickets/${ticket.id}`).set(auth(customer));

      // 404 rather than 403, so ticket ids cannot be probed for existence.
      expect(response.status).toBe(404);
    });

    it('cannot see another customer’s ticket in a list', async () => {
      await createTicket(otherCustomer, 'Sneha private issue', 'This belongs to another customer.');
      await createTicket(customer, 'My own issue', 'This is my own ticket and I should see it.');

      const response = await request(app).get('/api/tickets').set(auth(customer));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].subject).toBe('My own issue');
    });

    it('cannot post a message on another customer’s ticket', async () => {
      const ticket = await createTicket(otherCustomer);

      const response = await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer))
        .send({ body: 'Trying to intrude on this thread.' });

      expect(response.status).toBe(404);
    });

    it('cannot add an internal note on their own ticket', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer))
        .send({ body: 'Secret note', isInternalNote: true });

      expect(response.status).toBe(403);
    });

    it('cannot see staff internal notes on their own ticket', async () => {
      const ticket = await createTicket(customer);
      await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(agent))
        .send({ body: 'Internal: check the payment gateway logs.', isInternalNote: true });
      await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(agent))
        .send({ body: 'We are looking into this for you.' });

      const response = await request(app)
        .get(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].body).toBe('We are looking into this for you.');
    });

    it('cannot assign a ticket', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/assign`)
        .set(auth(customer))
        .send({ agentId: agent.id });

      expect(response.status).toBe(403);
    });

    it('cannot delete a ticket', async () => {
      const ticket = await createTicket(customer);
      const response = await request(app).delete(`/api/tickets/${ticket.id}`).set(auth(customer));
      expect(response.status).toBe(403);
    });

    it('cannot use the AI assistance endpoints', async () => {
      const ticket = await createTicket(customer);
      const response = await request(app)
        .post(`/api/ai/tickets/${ticket.id}/draft-reply`)
        .set(auth(customer));
      expect(response.status).toBe(403);
    });
  });

  describe('an agent', () => {
    it('cannot list all users', async () => {
      const response = await request(app).get('/api/users').set(auth(agent));
      expect(response.status).toBe(403);
    });

    it('cannot change a role', async () => {
      const response = await request(app)
        .patch(`/api/users/${customer.id}/role`)
        .set(auth(agent))
        .send({ role: 'ADMIN' });
      expect(response.status).toBe(403);
    });

    it('cannot create a category', async () => {
      const response = await request(app)
        .post('/api/categories')
        .set(auth(agent))
        .send({ name: 'Agent Category' });
      expect(response.status).toBe(403);
    });

    it('cannot delete a ticket', async () => {
      const ticket = await createTicket(customer);
      const response = await request(app).delete(`/api/tickets/${ticket.id}`).set(auth(agent));
      expect(response.status).toBe(403);
    });

    it('cannot read the audit log', async () => {
      const response = await request(app).get('/api/audit-logs').set(auth(agent));
      expect(response.status).toBe(403);
    });

    it('cannot open the admin dashboard', async () => {
      const response = await request(app).get('/api/dashboard/admin').set(auth(agent));
      expect(response.status).toBe(403);
    });

    it('CAN see every customer’s ticket', async () => {
      await createTicket(customer, 'Rohan issue', 'A ticket raised by Rohan for the queue.');
      await createTicket(otherCustomer, 'Sneha issue', 'A ticket raised by Sneha for the queue.');

      const response = await request(app).get('/api/tickets').set(auth(agent));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });
  });

  describe('an admin', () => {
    it('can list users', async () => {
      const response = await request(app).get('/api/users').set(auth(admin));
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('can read the audit log', async () => {
      const response = await request(app).get('/api/audit-logs').set(auth(admin));
      expect(response.status).toBe(200);
    });

    it('cannot remove their own admin role', async () => {
      const response = await request(app)
        .patch(`/api/users/${admin.id}/role`)
        .set(auth(admin))
        .send({ role: 'CUSTOMER' });

      expect(response.status).toBe(422);
    });

    it('cannot deactivate their own account', async () => {
      const response = await request(app)
        .patch(`/api/users/${admin.id}/status`)
        .set(auth(admin))
        .send({ isActive: false });

      expect(response.status).toBe(422);
    });
  });
});
