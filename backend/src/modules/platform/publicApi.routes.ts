import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env';
import { requireApiKey, tenantOf } from '../../middleware/apiKey';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, created, paginationMeta } from '../../utils/http';
import { ApiError } from '../../utils/ApiError';
import { query, queryOne } from '../../db/pool';
import { sendTenantMessage, sendTenantTemplate } from '../../services/platform/messaging.service';
import { listNumbers } from '../../services/platform/onboarding.service';

/**
 * The public API a tenant's own software calls.
 *
 * Versioned under /v1 and separated from the console API on purpose: the
 * console can change with the UI, but anything here is a published contract
 * that a customer's code depends on. Authentication is by API key only — a
 * session cookie must never work here, or a malicious page could drive a
 * tenant's messaging by riding their browser session.
 */

export const publicApiRouter = Router();

// Per-key rather than per-IP: one tenant's traffic must not exhaust another's
// allowance when both sit behind the same cloud egress address.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.apiKeyId ?? req.ip ?? 'unknown',
  skip: () => isTest,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. The limit is 120 per minute per key.' },
  },
});

publicApiRouter.use(requireApiKey, apiLimiter);

// --- messages ---------------------------------------------------------------

const sendSchema = z
  .object({
    to: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 format, for example +919876543210.'),
    // Exactly one of text or template. Both, or neither, is a mistake worth
    // rejecting loudly rather than guessing at.
    text: z.string().min(1).max(4096).optional(),
    template: z
      .object({
        name: z.string().min(1),
        language: z.string().min(2).default('en'),
        variables: z.array(z.string()).max(10).optional(),
      })
      .optional(),
    from_number_id: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.template), {
    message: 'Provide either "text" or "template", not both.',
  });

/**
 * POST /v1/messages — send a WhatsApp message as this tenant.
 *
 * Honours an Idempotency-Key header: the same key within a tenant returns the
 * original result instead of sending again, so a client that times out and
 * retries cannot double-message a customer.
 */
publicApiRouter.post(
  '/messages',
  validate(sendSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = tenantOf(req);
    const { to, text, template, from_number_id: fromNumberId } = req.body;

    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.slice(0, 200) ?? null;

    const outcome = text
      ? await sendTenantMessage(tenantId, to, text, {
          numberId: fromNumberId ?? null,
          idempotencyKey,
        })
      : await sendTenantTemplate(tenantId, to, template, { numberId: fromNumberId ?? null });

    if (!outcome.delivered) {
      // 502: the request was valid, the upstream provider refused it. A 400
      // would wrongly tell the caller their input was wrong.
      throw new ApiError(502, 'PROVIDER_ERROR', outcome.error ?? 'The message could not be sent.');
    }

    created(res, {
      id: outcome.providerMessageId,
      to,
      status: 'accepted',
      deduplicated: outcome.deduplicated ?? false,
    });
  })
);

const listMessagesSchema = z.object({
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  contact: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

publicApiRouter.get(
  '/messages',
  validate(listMessagesSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = tenantOf(req);
    const { direction, contact, page, limit } = req.query as unknown as {
      direction?: string;
      contact?: string;
      page: number;
      limit: number;
    };

    const filters: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];

    if (direction) {
      params.push(direction);
      filters.push(`direction = $${params.length}::wa_direction`);
    }
    if (contact) {
      params.push(contact);
      filters.push(`wa_number = $${params.length}`);
    }

    const where = filters.join(' AND ');
    const offset = (page - 1) * limit;

    const rows = await query(
      `SELECT provider_message_id AS id, direction, wa_number AS contact, body,
              status::TEXT AS status, error_detail, created_at
         FROM whatsapp_messages
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const total = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM whatsapp_messages WHERE ${where}`,
      params
    );

    ok(res, rows, paginationMeta(page, limit, Number(total?.count ?? 0)));
  })
);

// --- numbers and contacts ---------------------------------------------------

publicApiRouter.get(
  '/numbers',
  asyncHandler(async (req: Request, res: Response) => {
    const numbers = await listNumbers(tenantOf(req));
    ok(
      res,
      numbers.map((n) => ({
        id: n.id,
        phone_number_id: n.phone_number_id,
        display_number: n.display_number,
        verified_name: n.verified_name,
        quality_rating: n.quality_rating,
        is_default: n.is_default,
        status: n.connection_status,
      }))
    );
  })
);

const contactsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  opted_in: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

publicApiRouter.get(
  '/contacts',
  validate(contactsSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = tenantOf(req);
    const { page, limit, opted_in: optedIn } = req.query as unknown as {
      page: number;
      limit: number;
      opted_in?: boolean;
    };

    const params: unknown[] = [tenantId];
    let where = 'tenant_id = $1';
    if (optedIn !== undefined) {
      params.push(optedIn);
      where += ` AND opted_in = $${params.length}`;
    }

    const rows = await query(
      `SELECT id, wa_number, name, opted_in, last_inbound_at, created_at
         FROM contacts WHERE ${where}
        ORDER BY last_inbound_at DESC NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    const total = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM contacts WHERE ${where}`,
      params
    );

    ok(res, rows, paginationMeta(page, limit, Number(total?.count ?? 0)));
  })
);

// --- introspection ----------------------------------------------------------

/**
 * GET /v1/me — what this key can do.
 *
 * The first call anyone makes when wiring up an integration, and the quickest
 * way to confirm a key works without sending a message to a real person.
 */
publicApiRouter.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = tenantOf(req);

    const tenant = await queryOne<{ id: string; name: string; slug: string; status: string }>(
      'SELECT id, name, slug, status::TEXT AS status FROM tenants WHERE id = $1',
      [tenantId]
    );

    const numbers = await listNumbers(tenantId);

    ok(res, {
      tenant,
      numbers: numbers.length,
      default_number: numbers.find((n) => n.is_default)?.display_number ?? null,
    });
  })
);
