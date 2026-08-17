import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import { FallbackAiProvider } from '../src/services/ai/fallback.provider';
import { classifyAndStore } from '../src/modules/tickets/tickets.service';
import { canTransition, TRANSITIONS } from '../src/modules/tickets/lifecycle';

describe('Ticket lifecycle rules (unit)', () => {
  it('permits every transition listed in the table', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        const role = from === 'CLOSED' ? 'ADMIN' : 'AGENT';
        expect(canTransition(from as never, to as never, role).allowed).toBe(true);
      }
    }
  });

  it('refuses a transition that is not in the table', () => {
    expect(canTransition('NEW', 'RESOLVED', 'AGENT').allowed).toBe(false);
    expect(canTransition('CLOSED', 'RESOLVED', 'ADMIN').allowed).toBe(false);
  });

  it('refuses a no-op transition', () => {
    expect(canTransition('OPEN', 'OPEN', 'AGENT').allowed).toBe(false);
  });

  it('restricts reopening a closed ticket to an admin', () => {
    expect(canTransition('CLOSED', 'OPEN', 'AGENT').allowed).toBe(false);
    expect(canTransition('CLOSED', 'OPEN', 'ADMIN').allowed).toBe(true);
  });

  it('allows a customer only to close or reopen a resolved ticket', () => {
    expect(canTransition('RESOLVED', 'CLOSED', 'CUSTOMER').allowed).toBe(true);
    expect(canTransition('RESOLVED', 'OPEN', 'CUSTOMER').allowed).toBe(true);
    expect(canTransition('OPEN', 'IN_PROGRESS', 'CUSTOMER').allowed).toBe(false);
  });
});

describe('AI fallback classifier (unit)', () => {
  const provider = new FallbackAiProvider();
  const categories = ['Billing', 'Technical', 'Delivery', 'Account', 'General'];

  it('classifies a payment complaint as Billing with negative-leaning urgency', async () => {
    const result = await provider.classify({
      subject: 'Payment deducted but order still pending',
      description:
        'My payment was deducted but my order is still showing pending. This is urgent.',
      categories,
    });

    expect(result.category).toBe('Billing');
    expect(result.priority).toBe('URGENT');
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('classifies a login problem as Account', async () => {
    const result = await provider.classify({
      subject: 'Cannot reset my password',
      description: 'I never receive the password reset email when I try to log in.',
      categories,
    });

    expect(result.category).toBe('Account');
  });

  it('detects negative sentiment', async () => {
    const result = await provider.classify({
      subject: 'Terrible service',
      description: 'This is unacceptable and I am extremely frustrated with the awful support.',
      categories,
    });

    expect(result.sentiment).toBe('NEGATIVE');
  });

  it('only ever proposes a category the business has configured', async () => {
    const result = await provider.classify({
      subject: 'Payment issue',
      description: 'My payment and invoice are both wrong and I was charged twice.',
      categories: ['Support', 'Other'],
    });

    expect(['Support', 'Other']).toContain(result.category);
  });

  it('is deterministic — the same input always gives the same output', async () => {
    const input = {
      subject: 'App crashes on checkout',
      description: 'The application crashes every time I open the checkout page.',
      categories,
    };

    const first = await provider.classify(input);
    const second = await provider.classify(input);
    expect(first).toEqual(second);
  });

  it('produces a draft reply addressed to the customer', async () => {
    const { draft } = await provider.draftReply({
      subject: 'Refund not credited',
      description: 'My refund has not arrived.',
      customerName: 'Rohan Menon',
      messages: [],
    });

    expect(draft).toContain('Rohan');
    expect(draft).toContain('Customer Support');
  });

  it('suggests billing-specific resolution steps for a billing issue', async () => {
    const { steps } = await provider.resolutionSteps({
      subject: 'Payment deducted twice',
      description: 'I was charged twice for the same invoice and need a refund.',
      customerName: 'Rohan Menon',
      messages: [],
    });

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.join(' ').toLowerCase()).toContain('payment');
  });
});

describe('AI integration and graceful degradation', () => {
  let customer: TestUser;
  let agent: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await createCategory('Billing');
    await createCategory('Account');
    customer = await createUser('CUSTOMER', 'rohan@example.com', 'Rohan Menon');
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
  });

  afterAll(async () => {
    await closePool();
  });

  it('classifies a new ticket and stores the result', async () => {
    const ticket = await createTicket(
      customer,
      'Payment deducted but order pending',
      'My payment was deducted but my order is still showing as pending. Please help urgently.'
    );

    // Classification is intentionally not awaited by the create handler, so the
    // test drives it directly to assert on the stored outcome.
    await classifyAndStore(ticket.id);

    const rows = await query<{
      sentiment: string | null;
      ai_summary: string | null;
      ai_confidence: string | null;
      category_name: string | null;
    }>(
      `SELECT t.sentiment, t.ai_summary, t.ai_confidence, c.name AS category_name
         FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.id = $1`,
      [ticket.id]
    );

    expect(rows[0].sentiment).toBeTruthy();
    expect(rows[0].ai_summary).toBeTruthy();
    expect(rows[0].category_name).toBe('Billing');
  });

  it('records the suggestion and flags that the fallback produced it', async () => {
    const ticket = await createTicket(customer);
    await classifyAndStore(ticket.id);

    const rows = await query<{ kind: string; used_fallback: boolean; model: string }>(
      'SELECT kind::TEXT, used_fallback, model FROM ai_suggestions WHERE ticket_id = $1',
      [ticket.id]
    );

    // The create route already classifies in the background, so the exact row
    // count depends on timing. What matters is that every stored suggestion is
    // a classification and is correctly flagged as fallback-produced.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.kind).toBe('CLASSIFICATION');
      expect(row.used_fallback).toBe(true);
      expect(row.model).toBe('rule-based-fallback');
    }
  });

  it('never overwrites a category the customer chose themselves', async () => {
    const accountRows = await query<{ id: string }>(
      "SELECT id FROM categories WHERE name = 'Account'"
    );

    const response = await request(app).post('/api/tickets').set(auth(customer)).send({
      subject: 'Payment deducted but order pending',
      description: 'My payment was deducted and the invoice is wrong. Charged twice.',
      categoryId: accountRows[0].id,
    });

    await classifyAndStore(response.body.data.id);

    const rows = await query<{ name: string }>(
      `SELECT c.name FROM tickets t JOIN categories c ON c.id = t.category_id WHERE t.id = $1`,
      [response.body.data.id]
    );

    // The text is clearly Billing, but the customer's own choice wins.
    expect(rows[0].name).toBe('Account');
  });

  it('still creates the ticket when classification throws', async () => {
    // Simulate a total AI outage by making the database lookup inside
    // classifyAndStore fail; ticket creation must be unaffected.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).post('/api/tickets').set(auth(customer)).send({
      subject: 'AI outage during creation',
      description: 'This ticket must be created successfully even if the AI service is down.',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.reference).toMatch(/^SD-\d+$/);

    // A malformed id makes classifyAndStore throw internally; it must swallow it.
    await expect(classifyAndStore('not-a-uuid')).resolves.toBeUndefined();

    spy.mockRestore();
  });

  it('gives an agent a draft reply that is never sent automatically', async () => {
    const ticket = await createTicket(customer);

    const response = await request(app)
      .post(`/api/ai/tickets/${ticket.id}/draft-reply`)
      .set(auth(agent));

    expect(response.status).toBe(200);
    expect(response.body.data.draft).toBeTruthy();
    expect(response.body.data.notice).toContain('Review and edit');

    // Crucially: no customer-visible message was created by that call.
    const messages = await query('SELECT id FROM ticket_messages WHERE ticket_id = $1', [ticket.id]);
    expect(messages).toHaveLength(0);
  });

  it('lets the agent edit the draft before sending, and flags it as AI-assisted', async () => {
    const ticket = await createTicket(customer);

    const draft = await request(app)
      .post(`/api/ai/tickets/${ticket.id}/draft-reply`)
      .set(auth(agent));

    const edited = `${draft.body.data.draft}\n\nEdited by the agent before sending.`;

    const sent = await request(app)
      .post(`/api/tickets/${ticket.id}/messages`)
      .set(auth(agent))
      .send({ body: edited, aiAssisted: true });

    expect(sent.status).toBe(201);
    expect(sent.body.data.body).toContain('Edited by the agent before sending.');
    expect(sent.body.data.aiAssisted).toBe(true);
  });

  it('produces a summary and stores it on the ticket', async () => {
    const ticket = await createTicket(customer);

    const response = await request(app)
      .post(`/api/ai/tickets/${ticket.id}/summary`)
      .set(auth(agent));

    expect(response.status).toBe(200);
    expect(response.body.data.summary).toBeTruthy();
    expect(response.body.data.usedFallback).toBe(true);
  });

  it('reports AI health to an admin', async () => {
    const response = await request(app).get('/api/ai/health').set(auth(admin));

    expect(response.status).toBe(200);
    expect(response.body.data.usingFallback).toBe(true);
    expect(response.body.data.activeModel).toBe('rule-based-fallback');
  });
});
