import { query, queryOne } from '../../db/pool';
import { ApiError } from '../../utils/ApiError';
import { classifyTicket } from '../../services/ai';
import type { AuthenticatedUser, TicketStatus } from '../../types';
import type { ListTicketsQuery } from './tickets.schemas';

/** Columns every ticket response is built from, joined to human-readable names. */
const TICKET_SELECT = `
  t.id, t.reference, t.subject, t.description, t.priority, t.status, t.sentiment,
  t.ai_summary, t.ai_confidence, t.ai_classified_at, t.channel,
  t.created_at, t.updated_at, t.first_response_at, t.resolved_at, t.closed_at,
  t.customer_id, cu.full_name AS customer_name, cu.email AS customer_email,
  t.assigned_agent_id, ag.full_name AS agent_name,
  t.category_id, cat.name AS category_name
`;

const TICKET_FROM = `
  FROM tickets t
  JOIN users cu ON cu.id = t.customer_id
  LEFT JOIN users ag ON ag.id = t.assigned_agent_id
  LEFT JOIN categories cat ON cat.id = t.category_id
`;

export interface TicketRow {
  id: string;
  reference: string;
  subject: string;
  description: string;
  priority: string;
  status: TicketStatus;
  sentiment: string | null;
  ai_summary: string | null;
  ai_confidence: string | null;
  ai_classified_at: Date | null;
  channel: string;
  created_at: Date;
  updated_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  assigned_agent_id: string | null;
  agent_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

export function toTicketDto(row: TicketRow) {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    sentiment: row.sentiment,
    aiSummary: row.ai_summary,
    aiConfidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
    aiClassifiedAt: row.ai_classified_at,
    channel: row.channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstResponseAt: row.first_response_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
    agent: row.assigned_agent_id
      ? { id: row.assigned_agent_id, name: row.agent_name }
      : null,
    category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
  };
}

/**
 * Builds the WHERE clause for a ticket list.
 *
 * Role scoping happens here rather than in each route: a customer's query is
 * silently narrowed to their own rows, so there is no code path in which a
 * customer can list another customer's tickets even if they craft the filters.
 */
function buildFilters(
  user: AuthenticatedUser,
  filters: ListTicketsQuery
): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('$?', `$${params.length}`));
  };

  if (user.role === 'CUSTOMER') {
    add('t.customer_id = $?', user.id);
  } else if (filters.customerId) {
    add('t.customer_id = $?', filters.customerId);
  }

  if (filters.status) add('t.status = $?', filters.status);
  if (filters.priority) add('t.priority = $?', filters.priority);
  if (filters.sentiment) add('t.sentiment = $?', filters.sentiment);
  if (filters.categoryId) add('t.category_id = $?', filters.categoryId);

  if (filters.agentId === 'unassigned') {
    clauses.push('t.assigned_agent_id IS NULL');
  } else if (filters.agentId) {
    add('t.assigned_agent_id = $?', filters.agentId);
  }

  if (filters.from) add('t.created_at >= $?', filters.from);
  if (filters.to) add('t.created_at <= $?', filters.to);

  // Text search covers the reference a customer quotes, the subject, the
  // customer's name, and the full body via the GIN index.
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const like = `$${params.length}`;
    params.push(filters.q);
    const fts = `$${params.length}`;
    clauses.push(
      `(t.reference ILIKE ${like} OR t.subject ILIKE ${like} OR cu.full_name ILIKE ${like}
        OR to_tsvector('english', t.subject || ' ' || t.description) @@ plainto_tsquery('english', ${fts}))`
    );
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 't.created_at',
  updatedAt: 't.updated_at',
  status: 't.status',
  // Enum ordering follows the declared order, so URGENT sorts above LOW.
  priority: 't.priority',
};

export async function listTickets(user: AuthenticatedUser, filters: ListTicketsQuery) {
  const { where, params } = buildFilters(user, filters);

  const totalRows = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count ${TICKET_FROM} ${where}`,
    params
  );
  const total = Number(totalRows[0]?.count ?? 0);

  // Sort column comes from a fixed map, never from raw user input.
  const sortColumn = SORT_COLUMNS[filters.sort] ?? 't.created_at';
  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (filters.page - 1) * filters.limit;

  const rows = await query<TicketRow>(
    `SELECT ${TICKET_SELECT} ${TICKET_FROM} ${where}
     ORDER BY ${sortColumn} ${direction}, t.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.limit, offset]
  );

  return { tickets: rows.map(toTicketDto), total };
}

/**
 * Fetches one ticket and enforces record-level access.
 *
 * This is the second authorisation layer. Route middleware already checked the
 * role; this checks whether *this* record belongs to *this* user.
 */
export async function getTicketForUser(
  ticketId: string,
  user: AuthenticatedUser
): Promise<TicketRow> {
  const ticket = await queryOne<TicketRow>(
    `SELECT ${TICKET_SELECT} ${TICKET_FROM} WHERE t.id = $1`,
    [ticketId]
  );

  if (!ticket) throw ApiError.notFound('Ticket not found.');

  if (user.role === 'CUSTOMER' && ticket.customer_id !== user.id) {
    // Deliberately 404, not 403: a customer should not be able to discover that
    // a ticket exists by probing identifiers.
    throw ApiError.notFound('Ticket not found.');
  }

  return ticket;
}

export async function recordEvent(
  ticketId: string,
  actorId: string | null,
  eventType: string,
  fromValue: string | null,
  toValue: string | null
): Promise<void> {
  await query(
    `INSERT INTO ticket_events (ticket_id, actor_id, event_type, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticketId, actorId, eventType, fromValue, toValue]
  );
}

/**
 * Runs AI classification and stores the result.
 *
 * Called *after* the ticket row is committed and never awaited by the create
 * handler's response path, so a slow or failing AI provider cannot delay or
 * break ticket creation. Any error is logged and dropped: the ticket simply
 * stays unclassified and an agent triages it by hand.
 */
export async function classifyAndStore(ticketId: string): Promise<void> {
  try {
    const ticket = await queryOne<{ subject: string; description: string; category_id: string | null }>(
      'SELECT subject, description, category_id FROM tickets WHERE id = $1',
      [ticketId]
    );
    if (!ticket) return;

    const categories = await query<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE is_active = TRUE ORDER BY name'
    );

    const outcome = await classifyTicket({
      subject: ticket.subject,
      description: ticket.description,
      categories: categories.map((c) => c.name),
    });

    const { category, priority, sentiment, summary, confidence } = outcome.result;
    const matched = categories.find((c) => c.name.toLowerCase() === category.toLowerCase());

    await query(
      `UPDATE tickets
          SET sentiment = $1,
              ai_summary = $2,
              ai_confidence = $3,
              ai_classified_at = NOW(),
              -- never overwrite a category the customer chose themselves
              category_id = COALESCE(category_id, $4),
              priority = CASE WHEN status = 'NEW' THEN $5::ticket_priority ELSE priority END
        WHERE id = $6`,
      [sentiment, summary, confidence, matched?.id ?? null, priority, ticketId]
    );

    await query(
      `INSERT INTO ai_suggestions (ticket_id, kind, content, model, used_fallback)
       VALUES ($1, 'CLASSIFICATION', $2, $3, $4)`,
      [ticketId, JSON.stringify(outcome.result), outcome.model, outcome.usedFallback]
    );
  } catch (error) {
    console.error('[tickets] classification failed:', (error as Error).message);
  }
}
