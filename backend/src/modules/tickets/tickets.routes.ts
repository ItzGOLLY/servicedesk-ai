import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, created, noContent, ok, paginationMeta } from '../../utils/http';
import { recordAudit } from '../../services/audit';
import { notify } from '../../services/notifications';
import { canTransition, timestampsForStatus } from './lifecycle';
import {
  assignTicketSchema,
  createMessageSchema,
  createTicketSchema,
  listTicketsSchema,
  updateStatusSchema,
  updateTicketSchema,
} from './tickets.schemas';
import {
  classifyAndStore,
  getTicketForUser,
  listTickets,
  recordEvent,
  toTicketDto,
  type TicketRow,
} from './tickets.service';

export const ticketsRouter = Router();

ticketsRouter.use(requireAuth);

// GET /api/tickets — role-scoped list with filtering, search and pagination
ticketsRouter.get(
  '/',
  validate(listTicketsSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = req.query as never;
    const { tickets, total } = await listTickets(req.user!, filters);
    ok(res, tickets, paginationMeta((filters as any).page, (filters as any).limit, total));
  })
);

// POST /api/tickets — customers raise tickets; an admin may raise one on their behalf
ticketsRouter.post(
  '/',
  requireRole('CUSTOMER', 'ADMIN'),
  validate(createTicketSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { subject, description, categoryId, priority } = req.body;

    const ticket = await queryOne<{ id: string; reference: string }>(
      `INSERT INTO tickets (customer_id, subject, description, category_id, priority, status)
       VALUES ($1, $2, $3, $4, COALESCE($5::ticket_priority, 'MEDIUM'), 'NEW')
       RETURNING id, reference`,
      [req.user!.id, subject, description, categoryId ?? null, priority ?? null]
    );

    if (!ticket) throw ApiError.internal('Could not create the ticket.');

    await recordEvent(ticket.id, req.user!.id, 'CREATED', null, 'NEW');
    await recordAudit(req, 'TICKET_CREATED', 'ticket', ticket.id, { reference: ticket.reference });

    // Classification runs after the row is committed and is not awaited, so the
    // customer's request returns immediately and an AI outage cannot block it.
    void classifyAndStore(ticket.id);

    const row = await queryOne<TicketRow>(
      `SELECT t.id, t.reference, t.subject, t.description, t.priority, t.status, t.sentiment,
              t.ai_summary, t.ai_confidence, t.ai_classified_at, t.created_at, t.updated_at,
              t.first_response_at, t.resolved_at, t.closed_at,
              t.customer_id, cu.full_name AS customer_name, cu.email AS customer_email,
              t.assigned_agent_id, NULL::TEXT AS agent_name,
              t.category_id, cat.name AS category_name
         FROM tickets t
         JOIN users cu ON cu.id = t.customer_id
         LEFT JOIN categories cat ON cat.id = t.category_id
        WHERE t.id = $1`,
      [ticket.id]
    );

    created(res, toTicketDto(row!));
  })
);

// GET /api/tickets/:id
ticketsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    ok(res, toTicketDto(ticket));
  })
);

// PATCH /api/tickets/:id — staff edit subject, priority and category
ticketsRouter.patch(
  '/:id',
  requireRole('AGENT', 'ADMIN'),
  validate(updateTicketSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    const { subject, priority, categoryId } = req.body;

    const updated = await queryOne<{ id: string }>(
      `UPDATE tickets
          SET subject     = COALESCE($1, subject),
              priority    = COALESCE($2::ticket_priority, priority),
              category_id = CASE WHEN $3::BOOLEAN THEN $4::UUID ELSE category_id END
        WHERE id = $5
        RETURNING id`,
      [
        subject ?? null,
        priority ?? null,
        Object.prototype.hasOwnProperty.call(req.body, 'categoryId'),
        categoryId ?? null,
        ticket.id,
      ]
    );

    if (!updated) throw ApiError.notFound('Ticket not found.');

    if (priority && priority !== ticket.priority) {
      await recordEvent(ticket.id, req.user!.id, 'PRIORITY_CHANGED', ticket.priority, priority);
    }
    await recordAudit(req, 'TICKET_UPDATED', 'ticket', ticket.id, req.body);

    const fresh = await getTicketForUser(ticket.id, req.user!);
    ok(res, toTicketDto(fresh));
  })
);

// PATCH /api/tickets/:id/status — the guarded lifecycle transition
ticketsRouter.patch(
  '/:id/status',
  validate(updateStatusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    const { status } = req.body;

    const check = canTransition(ticket.status, status, req.user!.role);
    if (!check.allowed) throw ApiError.unprocessable(check.reason!);

    const stamps = timestampsForStatus(status);
    const resolvedExpr =
      stamps.resolvedAt === 'NOW' ? 'NOW()' : stamps.resolvedAt === 'NULL' ? 'NULL' : 'resolved_at';
    const closedExpr =
      stamps.closedAt === 'NOW' ? 'NOW()' : stamps.closedAt === 'NULL' ? 'NULL' : 'closed_at';

    await query(
      `UPDATE tickets
          SET status = $1, resolved_at = ${resolvedExpr}, closed_at = ${closedExpr}
        WHERE id = $2`,
      [status, ticket.id]
    );

    await recordEvent(ticket.id, req.user!.id, 'STATUS_CHANGED', ticket.status, status);
    await recordAudit(req, 'TICKET_STATUS_CHANGED', 'ticket', ticket.id, {
      from: ticket.status,
      to: status,
    });

    // Tell the customer, unless they made the change themselves.
    if (req.user!.id !== ticket.customer_id) {
      await notify(
        ticket.customer_id,
        status === 'RESOLVED' ? 'TICKET_RESOLVED' : 'TICKET_STATUS_CHANGED',
        `Ticket ${ticket.reference} is now ${status.replace(/_/g, ' ').toLowerCase()}`,
        `Your ticket "${ticket.subject}" moved from ${ticket.status} to ${status}.`,
        ticket.id
      );
    }

    const fresh = await getTicketForUser(ticket.id, req.user!);
    ok(res, toTicketDto(fresh));
  })
);

// PATCH /api/tickets/:id/assign
ticketsRouter.patch(
  '/:id/assign',
  requireRole('AGENT', 'ADMIN'),
  validate(assignTicketSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    const { agentId } = req.body;

    if (agentId) {
      const agent = await queryOne<{ id: string; full_name: string; role: string; is_active: boolean }>(
        'SELECT id, full_name, role, is_active FROM users WHERE id = $1',
        [agentId]
      );
      if (!agent) throw ApiError.notFound('That agent does not exist.');
      if (agent.role === 'CUSTOMER') {
        throw ApiError.unprocessable('Tickets can only be assigned to an agent or an admin.');
      }
      if (!agent.is_active) throw ApiError.unprocessable('That account is deactivated.');
    }

    await query(
      `UPDATE tickets
          SET assigned_agent_id = $1,
              -- picking up a brand-new ticket also opens it
              status = CASE WHEN status = 'NEW' AND $1::UUID IS NOT NULL THEN 'OPEN' ELSE status END
        WHERE id = $2`,
      [agentId, ticket.id]
    );

    await recordEvent(
      ticket.id,
      req.user!.id,
      agentId ? 'ASSIGNED' : 'UNASSIGNED',
      ticket.assigned_agent_id,
      agentId
    );
    await recordAudit(req, 'TICKET_ASSIGNED', 'ticket', ticket.id, { agentId });

    if (agentId && agentId !== req.user!.id) {
      await notify(
        agentId,
        'TICKET_ASSIGNED',
        `Ticket ${ticket.reference} assigned to you`,
        `${ticket.priority} priority — "${ticket.subject}"`,
        ticket.id
      );
    }
    if (agentId) {
      await notify(
        ticket.customer_id,
        'TICKET_ASSIGNED',
        `Ticket ${ticket.reference} has been assigned`,
        'A support agent is now looking into your request.',
        ticket.id
      );
    }

    const fresh = await getTicketForUser(ticket.id, req.user!);
    ok(res, toTicketDto(fresh));
  })
);

// DELETE /api/tickets/:id — admin only
ticketsRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await queryOne<{ id: string; reference: string }>(
      'SELECT id, reference FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (!ticket) throw ApiError.notFound('Ticket not found.');

    await query('DELETE FROM tickets WHERE id = $1', [ticket.id]);
    await recordAudit(req, 'TICKET_DELETED', 'ticket', ticket.id, { reference: ticket.reference });

    noContent(res);
  })
);

// GET /api/tickets/:id/events — the ticket timeline
ticketsRouter.get(
  '/:id/events',
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);

    const events = await query<{
      id: string;
      event_type: string;
      from_value: string | null;
      to_value: string | null;
      created_at: Date;
      actor_name: string | null;
    }>(
      `SELECT e.id, e.event_type, e.from_value, e.to_value, e.created_at, u.full_name AS actor_name
         FROM ticket_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.ticket_id = $1
        ORDER BY e.created_at ASC`,
      [ticket.id]
    );

    ok(
      res,
      events.map((e) => ({
        id: e.id,
        type: e.event_type,
        from: e.from_value,
        to: e.to_value,
        actor: e.actor_name,
        createdAt: e.created_at,
      }))
    );
  })
);

// GET /api/tickets/:id/messages
ticketsRouter.get(
  '/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    const isStaff = req.user!.role !== 'CUSTOMER';

    const messages = await query<{
      id: string;
      body: string;
      is_internal_note: boolean;
      ai_assisted: boolean;
      created_at: Date;
      author_id: string;
      author_name: string;
      author_role: string;
    }>(
      `SELECT m.id, m.body, m.is_internal_note, m.ai_assisted, m.created_at,
              m.author_id, u.full_name AS author_name, u.role AS author_role
         FROM ticket_messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.ticket_id = $1
          -- internal notes are filtered out in SQL, not in the client
          AND ($2::BOOLEAN OR m.is_internal_note = FALSE)
        ORDER BY m.created_at ASC`,
      [ticket.id, isStaff]
    );

    ok(
      res,
      messages.map((m) => ({
        id: m.id,
        body: m.body,
        isInternalNote: m.is_internal_note,
        aiAssisted: m.ai_assisted,
        createdAt: m.created_at,
        author: { id: m.author_id, name: m.author_name, role: m.author_role },
      }))
    );
  })
);

// POST /api/tickets/:id/messages
ticketsRouter.post(
  '/:id/messages',
  validate(createMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = await getTicketForUser(req.params.id, req.user!);
    const { body, isInternalNote, aiAssisted } = req.body;
    const isStaff = req.user!.role !== 'CUSTOMER';

    if (isInternalNote && !isStaff) {
      throw ApiError.forbidden('Only staff can add an internal note.');
    }
    if (ticket.status === 'CLOSED') {
      throw ApiError.unprocessable('This ticket is closed. Reopen it before replying.');
    }

    const message = await queryOne<{ id: string; created_at: Date }>(
      `INSERT INTO ticket_messages (ticket_id, author_id, body, is_internal_note, ai_assisted)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [ticket.id, req.user!.id, body, isInternalNote, aiAssisted]
    );

    // A public staff reply starts the response clock and moves the ticket along.
    if (isStaff && !isInternalNote) {
      await query(
        `UPDATE tickets
            SET first_response_at = COALESCE(first_response_at, NOW()),
                status = CASE WHEN status IN ('NEW', 'OPEN') THEN 'IN_PROGRESS' ELSE status END
          WHERE id = $1`,
        [ticket.id]
      );
      await notify(
        ticket.customer_id,
        'TICKET_REPLY',
        `New reply on ticket ${ticket.reference}`,
        'A support agent has replied to your request.',
        ticket.id
      );
    }

    // A customer reply on a waiting ticket hands it back to the agent.
    if (!isStaff) {
      await query(
        `UPDATE tickets
            SET status = CASE WHEN status = 'WAITING_FOR_CUSTOMER' THEN 'IN_PROGRESS' ELSE status END
          WHERE id = $1`,
        [ticket.id]
      );
      if (ticket.assigned_agent_id) {
        await notify(
          ticket.assigned_agent_id,
          'TICKET_REPLY',
          `Customer replied on ${ticket.reference}`,
          `"${ticket.subject}"`,
          ticket.id
        );
      }
    }

    created(res, {
      id: message!.id,
      body,
      isInternalNote,
      aiAssisted,
      createdAt: message!.created_at,
      author: { id: req.user!.id, name: null, role: req.user!.role },
    });
  })
);
