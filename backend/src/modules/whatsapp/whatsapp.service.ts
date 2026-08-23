import { query, queryOne } from '../../db/pool';
import { hashPassword } from '../../utils/security';
import { classifyAndStore, recordEvent } from '../tickets/tickets.service';
import { notify } from '../../services/notifications';
import { canTransition } from '../tickets/lifecycle';
import { normaliseNumber, sendMessage, templates, type InboundMessage } from '../../services/whatsapp';
import type { TicketPriority, TicketStatus } from '../../types';

/**
 * Inbound WhatsApp handling.
 *
 * A message from a phone number has no session and no password, so the number
 * itself is the identity. Everything here is driven by that one fact.
 */

interface TicketRow {
  id: string;
  reference: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: string | null;
}

const summaryOf = (t: TicketRow) => ({
  reference: t.reference,
  subject: t.subject,
  status: t.status,
  priority: t.priority,
  category: t.category,
});

/** Messages shorter than this are unlikely to describe a problem usefully. */
const MIN_TICKET_LENGTH = 12;

/**
 * Finds the account for a WhatsApp number, creating one if it is new.
 *
 * A customer who has never used the web application still gets a real account,
 * so their tickets, notifications and history behave exactly like anyone
 * else's. The account has no usable password — a random one is hashed and
 * discarded — so it cannot be signed into until the person sets one via the
 * normal flow. That avoids creating an account with a guessable credential.
 */
async function findOrCreateCustomer(waNumber: string): Promise<{ id: string; full_name: string }> {
  const existing = await queryOne<{ id: string; full_name: string }>(
    'SELECT id, full_name FROM users WHERE whatsapp_number = $1',
    [waNumber]
  );
  if (existing) return existing;

  // A placeholder email keeps the NOT NULL/UNIQUE contract on users.email
  // without inventing an address that might belong to someone else.
  const placeholderEmail = `wa${waNumber.replace(/\D/g, '')}@whatsapp.local`;
  const unusablePassword = await hashPassword(
    `${waNumber}:${Date.now()}:${Math.round(Number.MAX_SAFE_INTEGER * 0.5)}`
  );

  const created = await queryOne<{ id: string; full_name: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone, whatsapp_number)
     VALUES ($1, $2, $3, 'CUSTOMER', $4, $4)
     ON CONFLICT (email) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number
     RETURNING id, full_name`,
    [placeholderEmail, unusablePassword, `WhatsApp ${waNumber.slice(-4)}`, waNumber]
  );

  return created!;
}

/** The most recent ticket this customer could still be talking about. */
async function mostRecentOpenTicket(customerId: string): Promise<TicketRow | null> {
  return queryOne<TicketRow>(
    `SELECT t.id, t.reference, t.subject, t.status, t.priority, c.name AS category
       FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.customer_id = $1 AND t.status <> 'CLOSED'
      ORDER BY t.updated_at DESC
      LIMIT 1`,
    [customerId]
  );
}

async function openTickets(customerId: string): Promise<TicketRow[]> {
  return query<TicketRow>(
    `SELECT t.id, t.reference, t.subject, t.status, t.priority, c.name AS category
       FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.customer_id = $1 AND t.status <> 'CLOSED'
      ORDER BY t.created_at DESC
      LIMIT 10`,
    [customerId]
  );
}

/** Subject line derived from the first sentence of the message. */
function deriveSubject(body: string): string {
  const firstLine = body.split('\n')[0].trim();
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0].trim() || firstLine;
  const subject = firstSentence.length >= 5 ? firstSentence : body.trim();
  return subject.length > 120 ? `${subject.slice(0, 117).trimEnd()}...` : subject;
}

/**
 * Accounts created from a number carry a placeholder name ("WhatsApp 5678"),
 * which must not be used as a greeting.
 */
function greetingName(fullName: string): string {
  return fullName.startsWith('WhatsApp ') ? 'there' : fullName.split(' ')[0] || 'there';
}

async function createTicketFrom(customerId: string, body: string): Promise<TicketRow> {
  const ticket = await queryOne<TicketRow>(
    `INSERT INTO tickets (customer_id, subject, description, status, channel)
     VALUES ($1, $2, $3, 'NEW', 'WHATSAPP')
     RETURNING id, reference, subject, status, priority, NULL::TEXT AS category`,
    [customerId, deriveSubject(body), body]
  );

  await recordEvent(ticket!.id, customerId, 'CREATED', null, 'NEW');

  // Classification runs after the row is committed and is not awaited, exactly
  // as on the web path, so a slow or failing AI provider cannot delay the reply
  // the customer is waiting on.
  void classifyAndStore(ticket!.id);

  return ticket!;
}

export interface InboundOutcome {
  handled: boolean;
  reason: string;
  ticketReference?: string;
}

/**
 * Processes one inbound message.
 *
 * Idempotent: the provider message id is inserted first with a unique
 * constraint, so a webhook replay is detected and dropped before any ticket is
 * created. Providers retry aggressively, and without this a single customer
 * message could raise several tickets.
 */
export async function handleInbound(
  inbound: InboundMessage,
  providerName: string
): Promise<InboundOutcome> {
  const waNumber = normaliseNumber(inbound.from);
  if (!waNumber) return { handled: false, reason: 'unrecognised sender number' };

  const body = inbound.body.trim();
  if (!body) return { handled: false, reason: 'empty message' };

  // Idempotency gate.
  const recorded = await queryOne<{ id: string }>(
    `INSERT INTO whatsapp_messages (direction, provider_message_id, wa_number, body, status, provider)
     VALUES ('INBOUND', $1, $2, $3, 'DELIVERED', $4)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING id`,
    [inbound.providerMessageId, waNumber, body, providerName]
  );
  if (!recorded) return { handled: false, reason: 'duplicate webhook delivery' };

  const customer = await findOrCreateCustomer(waNumber);
  const keyword = body.toUpperCase().replace(/[^A-Z]/g, '');

  await query('UPDATE whatsapp_messages SET user_id = $1 WHERE id = $2', [customer.id, recorded.id]);

  const reply = async (text: string, ticketId: string | null = null) => {
    await sendMessage(waNumber, text, { ticketId, userId: customer.id });
  };

  // --- keywords ------------------------------------------------------------

  if (keyword === 'HELP' || keyword === 'MENU') {
    await reply(templates.helpText());
    return { handled: true, reason: 'help' };
  }

  if (keyword === 'STATUS') {
    const tickets = await openTickets(customer.id);
    await reply(templates.statusSummary(tickets.map(summaryOf)));
    return { handled: true, reason: 'status' };
  }

  if (keyword === 'CLOSE') {
    const latest = await mostRecentOpenTicket(customer.id);
    if (!latest) {
      await reply(templates.statusSummary([]));
      return { handled: true, reason: 'close with no open ticket' };
    }

    const check = canTransition(latest.status, 'CLOSED', 'CUSTOMER');
    if (!check.allowed) {
      // The reason matters here: "is now open" would imply something happened.
      await reply(templates.closeRefused(summaryOf(latest), check.reason!), latest.id);
      return { handled: true, reason: `close refused: ${check.reason}` };
    }

    await query(`UPDATE tickets SET status = 'CLOSED', closed_at = NOW() WHERE id = $1`, [latest.id]);
    await recordEvent(latest.id, customer.id, 'STATUS_CHANGED', latest.status, 'CLOSED');
    await reply(templates.ticketClosed(summaryOf(latest)), latest.id);
    return { handled: true, reason: 'closed', ticketReference: latest.reference };
  }

  // NEW raises a separate request even when one is already open. It is matched
  // on the raw text rather than the collapsed keyword so a description can
  // follow it: "NEW my replacement never arrived".
  const newCommand = /^new\b\s*([\s\S]*)$/i.exec(body);
  if (newCommand) {
    const description = newCommand[1].trim();

    if (description.length < MIN_TICKET_LENGTH) {
      await reply(templates.describeForNew());
      return { handled: true, reason: 'new requested without a description' };
    }

    const ticket = await createTicketFrom(customer.id, description);
    await query('UPDATE whatsapp_messages SET ticket_id = $1 WHERE id = $2', [
      ticket.id,
      recorded.id,
    ]);
    await reply(templates.ticketCreated(summaryOf(ticket), greetingName(customer.full_name)), ticket.id);

    return { handled: true, reason: 'ticket created', ticketReference: ticket.reference };
  }

  const content = body;

  // --- a message that is not a keyword -------------------------------------

  const latest = await mostRecentOpenTicket(customer.id);

  // An existing open conversation receives the message as a reply, rather than
  // spawning a second ticket about the same problem.
  if (latest) {
    const message = await queryOne<{ id: string }>(
      `INSERT INTO ticket_messages (ticket_id, author_id, body, channel)
       VALUES ($1, $2, $3, 'WHATSAPP')
       RETURNING id`,
      [latest.id, customer.id, content]
    );

    await query('UPDATE whatsapp_messages SET ticket_id = $1, message_id = $2 WHERE id = $3', [
      latest.id,
      message!.id,
      recorded.id,
    ]);

    // A customer reply on a waiting ticket hands it back to the agent, matching
    // the behaviour of the web path.
    await query(
      `UPDATE tickets
          SET status = CASE WHEN status = 'WAITING_FOR_CUSTOMER' THEN 'IN_PROGRESS' ELSE status END
        WHERE id = $1`,
      [latest.id]
    );

    const assigned = await queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tickets WHERE id = $1',
      [latest.id]
    );
    if (assigned?.assigned_agent_id) {
      await notify(
        assigned.assigned_agent_id,
        'TICKET_REPLY',
        `WhatsApp reply on ${latest.reference}`,
        `"${latest.subject}"`,
        latest.id
      );
    }

    await reply(templates.addedToTicket(summaryOf(latest)), latest.id);
    return { handled: true, reason: 'appended to open ticket', ticketReference: latest.reference };
  }

  if (content.length < MIN_TICKET_LENGTH) {
    await reply(templates.tooShort());
    return { handled: true, reason: 'too short for a ticket' };
  }

  const ticket = await createTicketFrom(customer.id, content);

  await query('UPDATE whatsapp_messages SET ticket_id = $1 WHERE id = $2', [ticket.id, recorded.id]);
  await reply(templates.ticketCreated(summaryOf(ticket), greetingName(customer.full_name)), ticket.id);

  return { handled: true, reason: 'ticket created', ticketReference: ticket.reference };
}
