import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  app,
  auth,
  createCategory,
  createTicket,
  createUser,
  migrateTestDatabase,
  resetDatabase,
  type TestUser,
} from './helpers';
import { closePool, query } from '../src/db/pool';

describe('Tickets — CRUD, lifecycle and search', () => {
  let customer: TestUser;
  let agent: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    customer = await createUser('CUSTOMER', 'rohan@example.com', 'Rohan Menon');
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
  });

  afterAll(async () => {
    await closePool();
  });

  describe('create', () => {
    it('creates a ticket with a readable reference and NEW status', async () => {
      const response = await request(app).post('/api/tickets').set(auth(customer)).send({
        subject: 'Payment deducted but order pending',
        description: 'My payment was deducted but the order still shows as pending.',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe('NEW');
      expect(response.body.data.reference).toMatch(/^SD-\d+$/);
      expect(response.body.data.customer.id).toBe(customer.id);
    });

    it('rejects a ticket with too short a description', async () => {
      const response = await request(app)
        .post('/api/tickets')
        .set(auth(customer))
        .send({ subject: 'Help me', description: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('BAD_REQUEST');
    });

    it('records a CREATED event on the timeline', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .get(`/api/tickets/${ticket.id}/events`)
        .set(auth(customer));

      expect(response.status).toBe(200);
      expect(response.body.data[0].type).toBe('CREATED');
      expect(response.body.data[0].to).toBe('NEW');
    });

    it('does not let an agent raise a ticket', async () => {
      const response = await request(app).post('/api/tickets').set(auth(agent)).send({
        subject: 'Agent raised ticket',
        description: 'Agents resolve tickets, they do not raise them as customers.',
      });

      expect(response.status).toBe(403);
    });
  });

  describe('read and update', () => {
    it('returns a ticket to its own customer', async () => {
      const ticket = await createTicket(customer);
      const response = await request(app).get(`/api/tickets/${ticket.id}`).set(auth(customer));

      expect(response.status).toBe(200);
      expect(response.body.data.reference).toBe(ticket.reference);
    });

    it('returns 404 for a ticket that does not exist', async () => {
      const response = await request(app)
        .get('/api/tickets/00000000-0000-0000-0000-000000000000')
        .set(auth(agent));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for a malformed identifier', async () => {
      const response = await request(app).get('/api/tickets/not-a-uuid').set(auth(agent));
      expect(response.status).toBe(400);
    });

    it('lets an agent change priority and records the change', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}`)
        .set(auth(agent))
        .send({ priority: 'URGENT' });

      expect(response.status).toBe(200);
      expect(response.body.data.priority).toBe('URGENT');

      const events = await request(app)
        .get(`/api/tickets/${ticket.id}/events`)
        .set(auth(agent));
      expect(events.body.data.some((e: { type: string }) => e.type === 'PRIORITY_CHANGED')).toBe(true);
    });

    it('lets an agent set the category', async () => {
      const categoryId = await createCategory('Billing');
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}`)
        .set(auth(agent))
        .send({ categoryId });

      expect(response.status).toBe(200);
      expect(response.body.data.category.name).toBe('Billing');
    });
  });

  describe('delete', () => {
    it('lets an admin delete a ticket', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app).delete(`/api/tickets/${ticket.id}`).set(auth(admin));
      expect(response.status).toBe(204);

      const after = await request(app).get(`/api/tickets/${ticket.id}`).set(auth(admin));
      expect(after.status).toBe(404);
    });

    it('cascades the delete to messages', async () => {
      const ticket = await createTicket(customer);
      await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(agent))
        .send({ body: 'Looking into this now.' });

      await request(app).delete(`/api/tickets/${ticket.id}`).set(auth(admin));

      const rows = await query('SELECT id FROM ticket_messages WHERE ticket_id = $1', [ticket.id]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('assignment', () => {
    it('assigns a ticket and moves it from NEW to OPEN', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/assign`)
        .set(auth(agent))
        .send({ agentId: agent.id });

      expect(response.status).toBe(200);
      expect(response.body.data.agent.id).toBe(agent.id);
      expect(response.body.data.status).toBe('OPEN');
    });

    it('notifies the agent it was assigned to', async () => {
      const ticket = await createTicket(customer);

      await request(app)
        .patch(`/api/tickets/${ticket.id}/assign`)
        .set(auth(admin))
        .send({ agentId: agent.id });

      const response = await request(app).get('/api/notifications').set(auth(agent));
      expect(response.body.data.some((n: { type: string }) => n.type === 'TICKET_ASSIGNED')).toBe(true);
    });

    it('refuses to assign a ticket to a customer', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/assign`)
        .set(auth(agent))
        .send({ agentId: customer.id });

      expect(response.status).toBe(422);
    });
  });

  describe('status transitions', () => {
    it('allows NEW → OPEN', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'OPEN' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('OPEN');
    });

    it('rejects NEW → RESOLVED as an invalid transition', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'RESOLVED' });

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('cannot move from NEW to RESOLVED');
    });

    it('sets resolved_at when a ticket is resolved', async () => {
      const ticket = await createTicket(customer);
      await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'OPEN' });

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'RESOLVED' });

      expect(response.status).toBe(200);
      expect(response.body.data.resolvedAt).toBeTruthy();
    });

    it('clears resolved_at when a resolved ticket is reopened', async () => {
      const ticket = await createTicket(customer);
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'OPEN' });
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'RESOLVED' });

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(customer))
        .send({ status: 'OPEN' });

      expect(response.status).toBe(200);
      expect(response.body.data.resolvedAt).toBeNull();
    });

    it('stops a customer moving their ticket to IN_PROGRESS', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(customer))
        .send({ status: 'IN_PROGRESS' });

      expect(response.status).toBe(422);
    });

    it('stops an agent reopening a closed ticket', async () => {
      const ticket = await createTicket(customer);
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'CLOSED' });

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'OPEN' });

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('administrator');
    });

    it('lets an admin reopen a closed ticket', async () => {
      const ticket = await createTicket(customer);
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'CLOSED' });

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(admin))
        .send({ status: 'OPEN' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('OPEN');
    });

    it('rejects an unknown status value', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'BANANA' });

      expect(response.status).toBe(400);
    });
  });

  describe('messages', () => {
    it('records a staff reply and starts the response clock', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(agent))
        .send({ body: 'Thanks for reaching out — I am checking this now.' });

      expect(response.status).toBe(201);

      const fresh = await request(app).get(`/api/tickets/${ticket.id}`).set(auth(agent));
      expect(fresh.body.data.firstResponseAt).toBeTruthy();
      expect(fresh.body.data.status).toBe('IN_PROGRESS');
    });

    it('rejects an empty message', async () => {
      const ticket = await createTicket(customer);

      const response = await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer))
        .send({ body: '   ' });

      expect(response.status).toBe(400);
    });

    it('refuses a reply on a closed ticket', async () => {
      const ticket = await createTicket(customer);
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'CLOSED' });

      const response = await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer))
        .send({ body: 'One more thing.' });

      expect(response.status).toBe(422);
    });

    it('returns a customer reply on a waiting ticket to IN_PROGRESS', async () => {
      const ticket = await createTicket(customer);
      await request(app).patch(`/api/tickets/${ticket.id}/status`).set(auth(agent)).send({ status: 'OPEN' });
      await request(app)
        .patch(`/api/tickets/${ticket.id}/status`)
        .set(auth(agent))
        .send({ status: 'WAITING_FOR_CUSTOMER' });

      await request(app)
        .post(`/api/tickets/${ticket.id}/messages`)
        .set(auth(customer))
        .send({ body: 'Here is the information you asked for.' });

      const fresh = await request(app).get(`/api/tickets/${ticket.id}`).set(auth(agent));
      expect(fresh.body.data.status).toBe('IN_PROGRESS');
    });
  });

  describe('search, filter and pagination', () => {
    beforeEach(async () => {
      await createTicket(customer, 'Refund not credited', 'My refund has not arrived after two weeks.');
      await createTicket(customer, 'App crashes on checkout', 'The app crashes when I open the checkout page.');
      await createTicket(customer, 'Wrong item delivered', 'I received a red shirt instead of a blue one.');
    });

    it('filters by status', async () => {
      const response = await request(app).get('/api/tickets?status=NEW').set(auth(agent));
      expect(response.status).toBe(200);
      expect(response.body.data.every((t: { status: string }) => t.status === 'NEW')).toBe(true);
    });

    it('finds a ticket by keyword in the body', async () => {
      const response = await request(app).get('/api/tickets?q=refund').set(auth(agent));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].subject).toBe('Refund not credited');
    });

    it('finds a ticket by its reference', async () => {
      const list = await request(app).get('/api/tickets').set(auth(agent));
      const reference = list.body.data[0].reference;

      const response = await request(app)
        .get(`/api/tickets?q=${encodeURIComponent(reference)}`)
        .set(auth(agent));

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].reference).toBe(reference);
    });

    it('finds tickets by customer name', async () => {
      const response = await request(app).get('/api/tickets?q=Rohan').set(auth(agent));
      expect(response.body.data.length).toBe(3);
    });

    it('filters for unassigned tickets', async () => {
      const response = await request(app).get('/api/tickets?agentId=unassigned').set(auth(agent));
      expect(response.body.data.every((t: { agent: unknown }) => t.agent === null)).toBe(true);
    });

    it('paginates and reports totals', async () => {
      const response = await request(app).get('/api/tickets?page=1&limit=2').set(auth(agent));

      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta.total).toBe(3);
      expect(response.body.meta.totalPages).toBe(2);
    });

    it('rejects an invalid limit', async () => {
      const response = await request(app).get('/api/tickets?limit=9999').set(auth(agent));
      expect(response.status).toBe(400);
    });
  });
});
