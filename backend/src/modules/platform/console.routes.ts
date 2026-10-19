import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, created, noContent, paginationMeta } from '../../utils/http';
import { ApiError } from '../../utils/ApiError';
import { query, queryOne } from '../../db/pool';
import { generateApiKey, generateWebhookSecret } from '../../utils/crypto';
import { recordAudit } from '../../services/audit';
import * as onboarding from '../../services/platform/onboarding.service';
import * as webhooks from '../../services/platform/webhooks.service';

/**
 * The console API — what a business sees and configures about their own
 * integration. Session-authenticated and admin-only within the tenant.
 *
 * Everything here is scoped by req.user.tenantId and never accepts a tenant id
 * from the client. A tenant cannot name another tenant, so there is nothing to
 * forge.
 */

export const platformConsoleRouter = Router();

platformConsoleRouter.use(requireAuth, requireRole('ADMIN'));

const tenantId = (req: Request): string => req.user!.tenantId;

// --- the tenant itself ------------------------------------------------------

platformConsoleRouter.get(
  '/tenant',
  asyncHandler(async (req: Request, res: Response) => {
    const tenant = await queryOne(
      `SELECT id, name, slug, status::TEXT AS status, helpdesk_enabled, contact_email, created_at
         FROM tenants WHERE id = $1`,
      [tenantId(req)]
    );
    ok(res, tenant);
  })
);

platformConsoleRouter.patch(
  '/tenant',
  validate(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      // Switching this off makes the platform a pure pipe: messages still
      // arrive and are logged, but no tickets are raised and nothing is
      // auto-replied, because the tenant answers them in their own system.
      helpdesk_enabled: z.boolean().optional(),
      contact_email: z.string().email().optional(),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, helpdesk_enabled: helpdesk, contact_email: email } = req.body;

    const updated = await queryOne(
      `UPDATE tenants
          SET name             = COALESCE($2, name),
              helpdesk_enabled = COALESCE($3, helpdesk_enabled),
              contact_email    = COALESCE($4, contact_email)
        WHERE id = $1
        RETURNING id, name, slug, status::TEXT AS status, helpdesk_enabled, contact_email`,
      [tenantId(req), name ?? null, helpdesk ?? null, email ?? null]
    );

    await recordAudit(req, 'TENANT_UPDATED', 'tenant', tenantId(req), { name, helpdesk });
    ok(res, updated);
  })
);

// --- Embedded Signup --------------------------------------------------------

/**
 * GET /platform/signup-config — what the browser needs to launch the dialog.
 *
 * The app id and the Facebook Login configuration id are public by design;
 * the app SECRET is not here and never leaves the server. Returning them from
 * the API rather than baking them into the bundle means the same frontend
 * build works against any deployment.
 */
platformConsoleRouter.get(
  '/signup-config',
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, {
      app_id: env.metaAppId,
      config_id: env.metaEmbeddedSignupConfigId,
      graph_version: env.metaGraphVersion,
      configured: Boolean(env.metaAppId && env.metaEmbeddedSignupConfigId && env.metaAppSecret),
    });
  })
);

/**
 * POST /platform/connections/embedded-signup
 *
 * Called by the browser with what Meta's dialog returned. Everything that
 * actually grants access happens on this side of the call: the code is
 * exchanged for a token here, so the token never exists in the browser.
 */
platformConsoleRouter.post(
  '/connections/embedded-signup',
  validate(
    z.object({
      code: z.string().min(10, 'The authorisation code from Embedded Signup is required.'),
      waba_id: z.string().min(1),
      phone_number_id: z.string().min(1),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { code, waba_id: wabaId, phone_number_id: phoneNumberId } = req.body;

    if (!env.metaAppId || !env.metaAppSecret) {
      throw new ApiError(
        503,
        'NOT_CONFIGURED',
        'This deployment has no Meta app credentials, so onboarding cannot complete.'
      );
    }

    // A WABA already held by a different tenant must not be silently moved:
    // that would hand one business another's messages.
    const existing = await queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM wa_connections WHERE waba_id = $1',
      [wabaId]
    );
    if (existing && existing.tenant_id !== tenantId(req)) {
      throw ApiError.conflict('This WhatsApp account is already connected to another workspace.');
    }

    try {
      const result = await onboarding.completeEmbeddedSignup({
        tenantId: tenantId(req),
        code,
        wabaId,
        phoneNumberId,
        onboardedBy: req.user!.id,
      });

      await recordAudit(req, 'WHATSAPP_CONNECTED', 'wa_connection', result.connectionId, {
        waba_id: wabaId,
        numbers: result.numbers.length,
      });

      created(res, result);
    } catch (error) {
      // The Graph failure is translated into something actionable rather than
      // surfacing "Permissions error" to a user who cannot act on it.
      throw new ApiError(502, 'ONBOARDING_FAILED', onboarding.describeFailure(error));
    }
  })
);

platformConsoleRouter.get(
  '/connections',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await onboarding.listConnections(tenantId(req)));
  })
);

platformConsoleRouter.delete(
  '/connections/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const removed = await onboarding.disconnect(tenantId(req), req.params.id);
    if (!removed) throw ApiError.notFound('No such connection.');

    await recordAudit(req, 'WHATSAPP_DISCONNECTED', 'wa_connection', req.params.id, {});
    noContent(res);
  })
);

platformConsoleRouter.get(
  '/numbers',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await onboarding.listNumbers(tenantId(req)));
  })
);

// --- API keys ---------------------------------------------------------------

platformConsoleRouter.get(
  '/api-keys',
  asyncHandler(async (req: Request, res: Response) => {
    const keys = await query(
      `SELECT id, name, prefix, last_used_at, revoked_at, created_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId(req)]
    );
    ok(res, keys);
  })
);

/**
 * Creates a key and returns it in full — once.
 *
 * Only the hash is stored, so this response is the single opportunity to copy
 * it. That is stated in the payload rather than left for the UI to remember.
 */
platformConsoleRouter.post(
  '/api-keys',
  validate(z.object({ name: z.string().trim().min(1).max(60) })),
  asyncHandler(async (req: Request, res: Response) => {
    const { key, prefix, hash } = generateApiKey();

    const row = await queryOne<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId(req), req.body.name, prefix, hash, req.user!.id]
    );

    await recordAudit(req, 'API_KEY_CREATED', 'api_key', row!.id, { name: req.body.name });

    created(res, {
      id: row!.id,
      name: req.body.name,
      prefix,
      key,
      warning: 'Copy this key now. It is stored only as a hash and cannot be shown again.',
    });
  })
);

platformConsoleRouter.delete(
  '/api-keys/:id',
  asyncHandler(async (req: Request, res: Response) => {
    // Revoked, not deleted: the audit log references it, and a vanished key
    // makes past activity unexplainable.
    const row = await queryOne<{ id: string }>(
      `UPDATE api_keys SET revoked_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [req.params.id, tenantId(req)]
    );
    if (!row) throw ApiError.notFound('No such API key.');

    await recordAudit(req, 'API_KEY_REVOKED', 'api_key', req.params.id, {});
    noContent(res);
  })
);

// --- webhook endpoints ------------------------------------------------------

platformConsoleRouter.get(
  '/webhook-endpoints',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await webhooks.listEndpoints(tenantId(req)));
  })
);

platformConsoleRouter.post(
  '/webhook-endpoints',
  validate(
    z.object({
      url: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
        message: 'Use an https:// URL (http is allowed only for localhost during development).',
      }),
      events: z
        .array(z.enum(['message.received', 'message.sent', 'message.status', 'template.status', 'connection.status']))
        .min(1)
        .default(['message.received', 'message.status']),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const secret = generateWebhookSecret();

    const row = await queryOne<{ id: string }>(
      `INSERT INTO webhook_endpoints (tenant_id, url, secret, events)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId(req), req.body.url, secret, req.body.events]
    );

    await recordAudit(req, 'WEBHOOK_ENDPOINT_CREATED', 'webhook_endpoint', row!.id, {
      url: req.body.url,
    });

    created(res, {
      id: row!.id,
      url: req.body.url,
      events: req.body.events,
      secret,
      warning: 'Store this signing secret now; it is not shown again.',
    });
  })
);

platformConsoleRouter.delete(
  '/webhook-endpoints/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await queryOne<{ id: string }>(
      'DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, tenantId(req)]
    );
    if (!row) throw ApiError.notFound('No such endpoint.');
    noContent(res);
  })
);

platformConsoleRouter.get(
  '/webhook-deliveries',
  validate(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    'query'
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const { rows, total } = await webhooks.deliveryHistory(tenantId(req), limit, (page - 1) * limit);
    ok(res, rows, paginationMeta(page, limit, total));
  })
);

/** Flushes retries on demand, so a tenant who has fixed their endpoint need not wait. */
platformConsoleRouter.post(
  '/webhook-deliveries/retry',
  asyncHandler(async (req: Request, res: Response) => {
    await query(
      `UPDATE webhook_deliveries
          SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(), delivered_at = NULL
        WHERE tenant_id = $1 AND status = 'FAILED'`,
      [tenantId(req)]
    );
    ok(res, await webhooks.dispatchDue(50));
  })
);

// --- analytics --------------------------------------------------------------

/**
 * Usage over a window, computed from the append-only usage_events table.
 *
 * generate_series fills days with no activity, so a chart shows a flat line
 * rather than silently omitting the gap.
 */
platformConsoleRouter.get(
  '/analytics',
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { days } = req.query as unknown as { days: number };
    const tenant = tenantId(req);

    const [totals, daily, numbers] = await Promise.all([
      query(
        `SELECT kind, SUM(quantity)::INT AS total
           FROM usage_events
          WHERE tenant_id = $1 AND occurred_at > NOW() - ($2 || ' days')::INTERVAL
          GROUP BY kind ORDER BY total DESC`,
        [tenant, days]
      ),
      query(
        `SELECT d::DATE AS day,
                COALESCE(SUM(u.quantity) FILTER (WHERE u.kind = 'message.received'), 0)::INT AS received,
                COALESCE(SUM(u.quantity) FILTER (WHERE u.kind = 'message.sent'), 0)::INT AS sent
           FROM generate_series(NOW() - ($2 || ' days')::INTERVAL, NOW(), '1 day') AS d
           LEFT JOIN usage_events u
             ON u.tenant_id = $1 AND u.occurred_at::DATE = d::DATE
          GROUP BY d ORDER BY d`,
        [tenant, days]
      ),
      query(
        `SELECT n.display_number,
                COUNT(*) FILTER (WHERE m.direction = 'INBOUND')::INT  AS inbound,
                COUNT(*) FILTER (WHERE m.direction = 'OUTBOUND')::INT AS outbound,
                COUNT(*) FILTER (WHERE m.status = 'FAILED')::INT      AS failed
           FROM wa_numbers n
           LEFT JOIN whatsapp_messages m ON m.number_id = n.id
          WHERE n.tenant_id = $1
          GROUP BY n.id, n.display_number
          ORDER BY n.display_number`,
        [tenant]
      ),
    ]);

    const deliveries = await queryOne(
      `SELECT COUNT(*)::INT AS total,
              COUNT(*) FILTER (WHERE status = 'DELIVERED')::INT AS delivered,
              COUNT(*) FILTER (WHERE status = 'FAILED')::INT    AS failed
         FROM webhook_deliveries WHERE tenant_id = $1`,
      [tenant]
    );

    ok(res, { totals, daily, numbers, webhook_deliveries: deliveries });
  })
);
