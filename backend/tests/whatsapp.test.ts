import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  app,
  auth,
  createCategory,
  createUser,
  migrateTestDatabase,
  resetDatabase,
  type TestUser,
} from './helpers';
import { closePool, query, queryOne } from '../src/db/pool';
import { handleInbound } from '../src/modules/whatsapp/whatsapp.service';
import { normaliseNumber } from '../src/services/whatsapp';
import * as t from '../src/services/whatsapp/format';
import { MetaWhatsAppProvider } from '../src/services/whatsapp/meta.provider';
import { env } from '../src/config/env';
import crypto from 'node:crypto';

const NUMBER = '+919000000001';
let counter = 0;
const inbound = (body: string, from = NUMBER) => ({
  providerMessageId: `test-${(counter += 1)}`,
  from,
  body,
});

describe('WhatsApp plain-text formatting (unit)', () => {
  it('converts Markdown bold to WhatsApp bold', () => {
    expect(t.toPlainText('This is **important** text')).toBe('This is *important* text');
  });

  it('turns a Markdown heading into a bold line, not literal hashes', () => {
    expect(t.toPlainText('## Order status')).toBe('*Order status*');
  });

  it('strips inline code markers', () => {
    expect(t.toPlainText('Run `npm start` now')).toBe('Run npm start now');
  });

  it('normalises list markers', () => {
    expect(t.toPlainText('* one\n+ two\n- three')).toBe('- one\n- two\n- three');
  });

  it('keeps link text and shows the URL', () => {
    expect(t.toPlainText('See [our policy](https://x.com/p)')).toBe(
      'See our policy (https://x.com/p)'
    );
  });

  it('collapses excessive blank lines', () => {
    expect(t.toPlainText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves plain text untouched', () => {
    const plain = 'Your refund has been processed and will arrive in 3 days.';
    expect(t.toPlainText(plain)).toBe(plain);
  });

  it('truncates over-long messages on a boundary, not mid-word', () => {
    const long = 'word '.repeat(1200);
    const out = t.truncate(long);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toContain('message truncated');
  });

  it('produces a ticket confirmation containing the reference', () => {
    const msg = t.ticketCreated(
      { reference: 'SD-1024', subject: 'Payment issue', status: 'NEW', priority: 'HIGH' },
      'Rohan'
    );
    expect(msg).toContain('SD-1024');
    expect(msg).toContain('Rohan');
    expect(msg).toContain('STATUS');
    // No Markdown may survive into a customer-facing message.
    expect(msg).not.toContain('**');
    expect(msg).not.toContain('##');
  });

  it('converts an agent reply written in Markdown before sending', () => {
    const msg = t.agentReply(
      { reference: 'SD-1', subject: 'S', status: 'OPEN', priority: 'LOW' },
      'Priya Nair',
      '## Update\nWe issued a **full refund**.'
    );
    expect(msg).toContain('*Update*');
    expect(msg).toContain('*full refund*');
    expect(msg).not.toContain('##');
    expect(msg).not.toContain('**');
  });
});

describe('WhatsApp number normalisation (unit)', () => {
  it('accepts and normalises common formats', () => {
    expect(normaliseNumber('+91 90000 00001')).toBe('+919000000001');
    expect(normaliseNumber('whatsapp:+919000000001')).toBe('+919000000001');
    expect(normaliseNumber('919000000001')).toBe('+919000000001');
  });

  it('rejects values that cannot be a phone number', () => {
    expect(normaliseNumber('hello')).toBeNull();
    expect(normaliseNumber('+0123')).toBeNull();
    expect(normaliseNumber('')).toBeNull();
  });
});

describe('Meta Cloud API provider (unit)', () => {
  const meta = new MetaWhatsAppProvider();
  const webhook = (value: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value }] }],
  });

  it('normalises an inbound text message to E.164 with a provider id', () => {
    const parsed = meta.parseWebhook(
      webhook({
        messages: [{ id: 'wamid.ABC', from: '919000000001', type: 'text', text: { body: 'hi' } }],
      })
    );
    expect(parsed).toEqual([{ providerMessageId: 'wamid.ABC', from: '+919000000001', body: 'hi' }]);
  });

  it('ignores delivery-status callbacks and non-text messages', () => {
    expect(meta.parseWebhook(webhook({ statuses: [{ id: 'wamid.X', status: 'read' }] }))).toEqual([]);
    expect(
      meta.parseWebhook(webhook({ messages: [{ id: 'wamid.Y', from: '919000000001', type: 'image' }] }))
    ).toEqual([]);
    expect(meta.parseWebhook({ object: 'page' })).toEqual([]);
    expect(meta.parseWebhook(undefined)).toEqual([]);
  });

  it('accepts a body signed with the app secret and rejects anything else', () => {
    const secret = 'unit-test-app-secret';
    const original = env.whatsappAppSecret;
    (env as { whatsappAppSecret: string }).whatsappAppSecret = secret;
    try {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      expect(meta.verifySignature(raw, { 'x-hub-signature-256': good })).toBe(true);
      expect(meta.verifySignature(raw + ' ', { 'x-hub-signature-256': good })).toBe(false);
      expect(meta.verifySignature(raw, { 'x-hub-signature-256': 'sha256=00' })).toBe(false);
      expect(meta.verifySignature(raw, {})).toBe(false);
    } finally {
      (env as { whatsappAppSecret: string }).whatsappAppSecret = original;
    }
  });
});

describe('WhatsApp inbound flow (integration)', () => {
  let agent: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await createCategory('Billing');
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
  });

  it('creates a customer account for a number it has not seen', async () => {
    await handleInbound(inbound('My payment was deducted but the order is pending.'), 'simulator');

    const user = await queryOne<{ role: string; whatsapp_number: string }>(
      'SELECT role, whatsapp_number FROM users WHERE whatsapp_number = $1',
      [NUMBER]
    );
    expect(user?.role).toBe('CUSTOMER');
  });

  it('raises a ticket from a message, marked as the WhatsApp channel', async () => {
    const outcome = await handleInbound(
      inbound('My payment was deducted but the order is still pending.'),
      'simulator'
    );

    expect(outcome.handled).toBe(true);
    expect(outcome.ticketReference).toMatch(/^SD-\d+$/);

    const ticket = await queryOne<{ channel: string; status: string; subject: string }>(
      'SELECT channel::TEXT, status::TEXT, subject FROM tickets WHERE reference = $1',
      [outcome.ticketReference!]
    );
    expect(ticket?.channel).toBe('WHATSAPP');
    expect(ticket?.status).toBe('NEW');
  });

  it('replies to the customer with a confirmation', async () => {
    const outcome = await handleInbound(
      inbound('The application crashes when I open checkout.'),
      'simulator'
    );

    const sent = await query<{ body: string; direction: string }>(
      `SELECT body, direction::TEXT FROM whatsapp_messages WHERE direction = 'OUTBOUND'`
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(outcome.ticketReference!);
  });

  it('ignores a replayed webhook instead of raising a second ticket', async () => {
    const message = inbound('My payment was deducted but the order is pending.');

    const first = await handleInbound(message, 'simulator');
    const second = await handleInbound(message, 'simulator');

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(second.reason).toContain('duplicate');

    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(1);
  });

  it('appends a follow-up message to the open ticket rather than creating another', async () => {
    await handleInbound(inbound('My payment was deducted but the order is pending.'), 'simulator');
    const second = await handleInbound(inbound('The order number is 4471.'), 'simulator');

    expect(second.reason).toContain('appended');

    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(1);

    const messages = await query<{ body: string; channel: string }>(
      `SELECT body, channel::TEXT FROM ticket_messages`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('The order number is 4471.');
    expect(messages[0].channel).toBe('WHATSAPP');
  });

  it('answers the STATUS keyword without creating a ticket', async () => {
    await handleInbound(inbound('My payment was deducted but the order is pending.'), 'simulator');
    const outcome = await handleInbound(inbound('STATUS'), 'simulator');

    expect(outcome.reason).toBe('status');
    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(1);
  });

  it('answers HELP with the command list', async () => {
    const outcome = await handleInbound(inbound('HELP'), 'simulator');
    expect(outcome.reason).toBe('help');

    const sent = await query<{ body: string }>(
      `SELECT body FROM whatsapp_messages WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
    );
    expect(sent[0].body).toContain('STATUS');
    expect(sent[0].body).toContain('HELP');
  });

  it('asks for more detail when the message is too short to be a ticket', async () => {
    const outcome = await handleInbound(inbound('hi'), 'simulator');
    expect(outcome.reason).toContain('too short');

    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(0);
  });

  it('lets the customer close a resolved ticket with CLOSE', async () => {
    const created = await handleInbound(
      inbound('My payment was deducted but the order is pending.'),
      'simulator'
    );
    const ticket = await queryOne<{ id: string }>('SELECT id FROM tickets WHERE reference = $1', [
      created.ticketReference!,
    ]);

    await request(app)
      .patch(`/api/tickets/${ticket!.id}/status`)
      .set(auth(agent))
      .send({ status: 'OPEN' });
    await request(app)
      .patch(`/api/tickets/${ticket!.id}/status`)
      .set(auth(agent))
      .send({ status: 'RESOLVED' });

    const outcome = await handleInbound(inbound('CLOSE'), 'simulator');
    expect(outcome.reason).toBe('closed');

    const after = await queryOne<{ status: string }>(
      'SELECT status::TEXT FROM tickets WHERE id = $1',
      [ticket!.id]
    );
    expect(after?.status).toBe('CLOSED');
  });

  it('raises a separate ticket for NEW with a description, even with one open', async () => {
    await handleInbound(inbound('My payment was deducted but the order is pending.'), 'simulator');
    const outcome = await handleInbound(
      inbound('NEW my replacement order has still not arrived'),
      'simulator'
    );

    expect(outcome.reason).toBe('ticket created');

    const tickets = await query<{ subject: string }>('SELECT subject FROM tickets ORDER BY created_at');
    expect(tickets).toHaveLength(2);
    expect(tickets[1].subject).toContain('replacement order');
  });

  it('asks for a description when NEW arrives on its own', async () => {
    const outcome = await handleInbound(inbound('NEW'), 'simulator');

    expect(outcome.reason).toContain('without a description');
    const tickets = await query('SELECT id FROM tickets');
    expect(tickets).toHaveLength(0);

    const sent = await query<{ body: string }>(
      `SELECT body FROM whatsapp_messages WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
    );
    expect(sent[0].body).toContain('what is the new issue');
  });

  it('does not treat a word merely starting with "new" as the NEW command', async () => {
    const outcome = await handleInbound(
      inbound('Newsletter signup is broken on your website checkout page.'),
      'simulator'
    );
    expect(outcome.reason).toBe('ticket created');
  });

  it('explains why CLOSE was refused instead of implying a status change', async () => {
    await handleInbound(inbound('My payment was deducted but the order is pending.'), 'simulator');

    // The ticket is NEW, so a customer cannot close it.
    const outcome = await handleInbound(inbound('CLOSE'), 'simulator');
    expect(outcome.reason).toContain('close refused');

    const sent = await query<{ body: string }>(
      `SELECT body FROM whatsapp_messages WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
    );
    expect(sent[0].body).toContain('could not close');
    expect(sent[0].body).not.toContain('is now');
  });

  it('rejects a sender number that is not a phone number', async () => {
    const outcome = await handleInbound(inbound('Hello there', 'not-a-number'), 'simulator');
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toContain('unrecognised');
  });
});

describe('WhatsApp outbound and admin console', () => {
  let customerNumber: string;
  let agent: TestUser;
  let admin: TestUser;
  let customer: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
    customer = await createUser('CUSTOMER', 'rohan@example.com', 'Rohan Menon');
    customerNumber = '+919000000009';
  });

  it('delivers an agent reply to the customer chat, converted to plain text', async () => {
    const created = await handleInbound(
      { providerMessageId: 'out-1', from: customerNumber, body: 'My refund has not arrived yet.' },
      'simulator'
    );
    const ticket = await queryOne<{ id: string }>('SELECT id FROM tickets WHERE reference = $1', [
      created.ticketReference!,
    ]);

    await request(app)
      .post(`/api/tickets/${ticket!.id}/messages`)
      .set(auth(agent))
      .send({ body: '## Update\nWe have issued a **full refund**.' });

    const sent = await query<{ body: string }>(
      `SELECT body FROM whatsapp_messages
        WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
    );

    expect(sent[0].body).toContain('Priya Nair');
    expect(sent[0].body).toContain('*full refund*');
    expect(sent[0].body).not.toContain('**');
    expect(sent[0].body).not.toContain('##');
  });

  it('does not send to WhatsApp for a ticket raised on the web', async () => {
    const web = await request(app).post('/api/tickets').set(auth(customer)).send({
      subject: 'Raised from the web application',
      description: 'This ticket did not come from WhatsApp and must not be messaged.',
    });

    await request(app)
      .post(`/api/tickets/${web.body.data.id}/messages`)
      .set(auth(agent))
      .send({ body: 'Looking into this now.' });

    const sent = await query(`SELECT id FROM whatsapp_messages WHERE direction = 'OUTBOUND'`);
    expect(sent).toHaveLength(0);
  });

  it('notifies the customer on WhatsApp when the status changes', async () => {
    const created = await handleInbound(
      { providerMessageId: 'out-2', from: customerNumber, body: 'My refund has not arrived yet.' },
      'simulator'
    );
    const ticket = await queryOne<{ id: string }>('SELECT id FROM tickets WHERE reference = $1', [
      created.ticketReference!,
    ]);

    await request(app)
      .patch(`/api/tickets/${ticket!.id}/status`)
      .set(auth(agent))
      .send({ status: 'OPEN' });

    const sent = await query<{ body: string }>(
      `SELECT body FROM whatsapp_messages
        WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
    );
    expect(sent[0].body).toContain('open');
  });

  it('reports channel status to an admin', async () => {
    const response = await request(app).get('/api/whatsapp/admin/status').set(auth(admin));

    expect(response.status).toBe(200);
    expect(response.body.data.simulated).toBe(true);
    expect(response.body.data.activeProvider).toBe('simulator');
  });

  it('refuses the admin console to an agent', async () => {
    const response = await request(app).get('/api/whatsapp/admin/status').set(auth(agent));
    expect(response.status).toBe(403);
  });

  it('refuses the admin console to a customer', async () => {
    const response = await request(app).get('/api/whatsapp/admin/messages').set(auth(customer));
    expect(response.status).toBe(403);
  });

  it('lets an admin simulate an inbound message end to end', async () => {
    const response = await request(app)
      .post('/api/whatsapp/admin/simulate')
      .set(auth(admin))
      .send({ from: '+919000000021', body: 'My order arrived damaged and I need a replacement.' });

    expect(response.status).toBe(200);
    expect(response.body.data.ticketReference).toMatch(/^SD-\d+$/);
  });

  it('rejects a malformed number in the simulate endpoint', async () => {
    const response = await request(app)
      .post('/api/whatsapp/admin/simulate')
      .set(auth(admin))
      .send({ from: 'not-a-number', body: 'Something is broken and needs attention.' });

    expect(response.status).toBe(400);
  });

  it('masks customer numbers in the admin message log', async () => {
    await handleInbound(
      { providerMessageId: 'mask-1', from: customerNumber, body: 'My refund has not arrived yet.' },
      'simulator'
    );

    const response = await request(app).get('/api/whatsapp/admin/messages').set(auth(admin));

    expect(response.status).toBe(200);
    expect(response.body.data[0].number).toMatch(/^••••\d{4}$/);
    expect(response.body.data[0].number).not.toContain('91900');
  });
});

// The pool is shared across every describe in this file, so it is closed once
// here rather than in each block — closing it twice throws.
afterAll(async () => {
  await closePool();
});
