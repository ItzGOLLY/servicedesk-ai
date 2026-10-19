import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, created, noContent, paginationMeta } from '../../utils/http';
import { ApiError } from '../../utils/ApiError';
import { query, queryOne, withTransaction } from '../../db/pool';
import { recordAudit } from '../../services/audit';
import { loggerFor } from '../../observability/logger';
import * as graph from '../../services/platform/graph.client';
import { sendingIdentity, describeFailure } from '../../services/platform/onboarding.service';
import { sendTenantTemplate } from '../../services/platform/messaging.service';
import { decryptSecret } from '../../utils/crypto';

const log = loggerFor('templates');

/**
 * Message templates and broadcasts.
 *
 * WhatsApp only lets a business open a conversation with an approved template,
 * so these two features are inseparable: a broadcast that is not a template is
 * simply refused by Meta. Templates are authored here, submitted to Meta for
 * review, and their approval status is synced back — a template is not usable
 * until Meta says APPROVED, and the UI must reflect Meta's opinion, not ours.
 */

export const templatesRouter = Router();
templatesRouter.use(requireAuth, requireRole('AGENT', 'ADMIN'));

const tenantId = (req: Request): string => req.user!.tenantId;

/** Counts {{1}}, {{2}} … so Meta's required examples can be validated up front. */
function countVariables(body: string): number {
  const found = new Set(
    [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]))
  );
  return found.size;
}

// --- templates --------------------------------------------------------------

templatesRouter.get(
  '/',
  validate(
    z.object({
      status: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    'query'
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { status, page, limit } = req.query as unknown as {
      status?: string;
      page: number;
      limit: number;
    };

    const params: unknown[] = [tenantId(req)];
    let where = 'tenant_id = $1';
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const rows = await query(
      `SELECT id, name, language, category, status, header_text, body_text, footer_text,
              variable_count, rejection_reason, meta_template_id, submitted_at, created_at
         FROM message_templates WHERE ${where}
        ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    const total = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM message_templates WHERE ${where}`,
      params
    );

    ok(res, rows, paginationMeta(page, limit, Number(total?.count ?? 0)));
  })
);

templatesRouter.post(
  '/',
  validate(
    z.object({
      // Meta's own constraint: lowercase, digits and underscores only.
      name: z
        .string()
        .trim()
        .regex(/^[a-z0-9_]{1,512}$/, 'Use lowercase letters, numbers and underscores only.'),
      language: z.string().trim().min(2).max(10).default('en'),
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'),
      header_text: z.string().trim().max(60).optional(),
      body_text: z.string().trim().min(1).max(1024),
      footer_text: z.string().trim().max(60).optional(),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, language, category, header_text: header, body_text: body, footer_text: footer } = req.body;

    const duplicate = await queryOne<{ id: string }>(
      'SELECT id FROM message_templates WHERE tenant_id = $1 AND name = $2 AND language = $3',
      [tenantId(req), name, language]
    );
    if (duplicate) {
      throw ApiError.conflict(`A ${language} template named "${name}" already exists.`);
    }

    const row = await queryOne(
      `INSERT INTO message_templates
         (tenant_id, name, language, category, header_text, body_text, footer_text, variable_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, language, category, status, body_text, variable_count, created_at`,
      [tenantId(req), name, language, category, header ?? null, body, footer ?? null, countVariables(body)]
    );

    await recordAudit(req, 'TEMPLATE_CREATED', 'message_template', (row as { id: string }).id, { name });
    created(res, row);
  })
);

/**
 * Submits a draft to Meta for review.
 *
 * Meta rejects a template containing {{1}} unless an example value is supplied
 * for every variable, so examples are required here rather than letting the
 * submission fail hours later with an opaque reason.
 */
templatesRouter.post(
  '/:id/submit',
  validate(z.object({ examples: z.array(z.string().min(1)).max(10).default([]) })),
  asyncHandler(async (req: Request, res: Response) => {
    const template = await queryOne<{
      id: string;
      name: string;
      language: string;
      category: string;
      header_text: string | null;
      body_text: string;
      footer_text: string | null;
      variable_count: number;
      status: string;
    }>(
      `SELECT id, name, language, category, header_text, body_text, footer_text, variable_count, status
         FROM message_templates WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId(req)]
    );

    if (!template) throw ApiError.notFound('No such template.');
    if (template.status === 'APPROVED') {
      throw ApiError.conflict('This template is already approved.');
    }

    const examples: string[] = req.body.examples;
    if (examples.length !== template.variable_count) {
      throw new ApiError(
        422,
        'EXAMPLES_REQUIRED',
        `This template has ${template.variable_count} variable(s), so Meta requires exactly that many example values.`
      );
    }

    const identity = await sendingIdentity(tenantId(req));
    if (!identity) {
      throw new ApiError(
        409,
        'NOT_CONNECTED',
        'Connect a WhatsApp account before submitting templates for approval.'
      );
    }

    try {
      const result = await graph.createTemplate({
        wabaId: identity.wabaId,
        token: identity.token,
        name: template.name,
        language: template.language,
        category: template.category,
        header: template.header_text ?? undefined,
        body: template.body_text,
        footer: template.footer_text ?? undefined,
        bodyExamples: examples.length ? examples : undefined,
      });

      const updated = await queryOne(
        `UPDATE message_templates
            SET meta_template_id = $2,
                status           = $3,
                submitted_at     = NOW(),
                rejection_reason = NULL,
                connection_id    = $4
          WHERE id = $1
          RETURNING id, name, status, meta_template_id, submitted_at`,
        [template.id, result.id, (result.status ?? 'PENDING').toUpperCase(), identity.connectionId]
      );

      await recordAudit(req, 'TEMPLATE_SUBMITTED', 'message_template', template.id, {
        name: template.name,
      });

      ok(res, updated);
    } catch (error) {
      log.error({ err: (error as Error).message, template: template.name }, 'template submission failed');
      throw new ApiError(502, 'SUBMISSION_FAILED', describeFailure(error));
    }
  })
);

/**
 * Pulls the current status of every template from Meta.
 *
 * Approval is asynchronous and Meta does not reliably push the result to a
 * webhook, so the authoritative status has to be fetched. Local rows are
 * updated from Meta, never the other way round.
 */
templatesRouter.post(
  '/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const identity = await sendingIdentity(tenantId(req));
    if (!identity) throw new ApiError(409, 'NOT_CONNECTED', 'No connected WhatsApp account.');

    try {
      const remote = await graph.listTemplates(identity.wabaId, identity.token);

      const updated = await withTransaction(async (client) => {
        let changed = 0;

        for (const item of remote) {
          const result = await client.query(
            `UPDATE message_templates
                SET status           = $3,
                    meta_template_id = COALESCE(meta_template_id, $4),
                    rejection_reason = $5
              WHERE tenant_id = $1 AND name = $2
                AND status IS DISTINCT FROM $3`,
            [
              tenantId(req),
              item.name,
              (item.status ?? 'PENDING').toUpperCase(),
              item.id,
              item.rejected_reason ?? null,
            ]
          );
          changed += result.rowCount ?? 0;
        }

        return changed;
      });

      ok(res, { checked: remote.length, updated });
    } catch (error) {
      throw new ApiError(502, 'SYNC_FAILED', describeFailure(error));
    }
  })
);

templatesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const row = await queryOne<{ id: string }>(
      'DELETE FROM message_templates WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, tenantId(req)]
    );
    if (!row) throw ApiError.notFound('No such template.');
    noContent(res);
  })
);

// --- broadcasts -------------------------------------------------------------

templatesRouter.get(
  '/broadcasts/list',
  asyncHandler(async (req: Request, res: Response) => {
    const rows = await query(
      `SELECT b.id, b.name, b.status, b.total_count, b.sent_count, b.failed_count,
              b.started_at, b.completed_at, b.created_at, t.name AS template_name
         FROM broadcasts b
         LEFT JOIN message_templates t ON t.id = b.template_id
        WHERE b.tenant_id = $1
        ORDER BY b.created_at DESC LIMIT 50`,
      [tenantId(req)]
    );
    ok(res, rows);
  })
);

/**
 * Creates and runs a broadcast.
 *
 * Deliberately refuses anything but an APPROVED template, and skips contacts
 * who have not opted in. Both are Meta policy, and breaking either risks the
 * tenant's number being rate-limited or banned — a consequence severe enough
 * that it is enforced here rather than trusted to the caller.
 */
templatesRouter.post(
  '/broadcasts',
  requireRole('ADMIN'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(120),
      template_id: z.string().uuid(),
      variables: z.array(z.string()).max(10).default([]),
      /** Omitted means every opted-in contact. */
      contact_ids: z.array(z.string().uuid()).max(5000).optional(),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, template_id: templateId, variables, contact_ids: contactIds } = req.body;
    const tenant = tenantId(req);

    const template = await queryOne<{ id: string; name: string; language: string; status: string }>(
      'SELECT id, name, language, status FROM message_templates WHERE id = $1 AND tenant_id = $2',
      [templateId, tenant]
    );
    if (!template) throw ApiError.notFound('No such template.');

    if (template.status !== 'APPROVED') {
      throw new ApiError(
        422,
        'TEMPLATE_NOT_APPROVED',
        `WhatsApp only delivers approved templates; this one is ${template.status}.`
      );
    }

    const recipients = await query<{ id: string; wa_number: string }>(
      contactIds?.length
        ? `SELECT id, wa_number FROM contacts
            WHERE tenant_id = $1 AND opted_in AND id = ANY($2::UUID[])`
        : `SELECT id, wa_number FROM contacts WHERE tenant_id = $1 AND opted_in`,
      contactIds?.length ? [tenant, contactIds] : [tenant]
    );

    if (recipients.length === 0) {
      throw new ApiError(422, 'NO_RECIPIENTS', 'No opted-in contacts match this broadcast.');
    }

    const broadcast = await queryOne<{ id: string }>(
      `INSERT INTO broadcasts (tenant_id, name, template_id, status, total_count, created_by, started_at)
       VALUES ($1, $2, $3, 'SENDING', $4, $5, NOW()) RETURNING id`,
      [tenant, name, templateId, recipients.length, req.user!.id]
    );

    for (const recipient of recipients) {
      await query(
        `INSERT INTO broadcast_recipients (broadcast_id, contact_id, wa_number)
         VALUES ($1, $2, $3) ON CONFLICT (broadcast_id, wa_number) DO NOTHING`,
        [broadcast!.id, recipient.id, recipient.wa_number]
      );
    }

    await recordAudit(req, 'BROADCAST_STARTED', 'broadcast', broadcast!.id, {
      name,
      recipients: recipients.length,
    });

    // Sending happens after the response: a few thousand recipients would
    // otherwise hold the request open well past any sensible timeout.
    void runBroadcast(broadcast!.id, tenant, template, variables).catch((error: unknown) => {
      log.error({ err: (error as Error).message, broadcastId: broadcast!.id }, 'broadcast failed');
    });

    created(res, { id: broadcast!.id, name, total: recipients.length, status: 'SENDING' });
  })
);

/**
 * Sends one broadcast, sequentially and with a small delay.
 *
 * Meta throttles per number, and a burst is the quickest way to have a
 * template paused. Slow and complete beats fast and rate-limited.
 */
async function runBroadcast(
  broadcastId: string,
  tenant: string,
  template: { name: string; language: string },
  variables: string[]
): Promise<void> {
  const pending = await query<{ id: string; wa_number: string }>(
    `SELECT id, wa_number FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'PENDING'`,
    [broadcastId]
  );

  let sent = 0;
  let failed = 0;

  for (const recipient of pending) {
    const outcome = await sendTenantTemplate(tenant, recipient.wa_number, {
      name: template.name,
      language: template.language,
      variables,
    });

    if (outcome.delivered) {
      sent += 1;
      await query(
        `UPDATE broadcast_recipients
            SET status = 'SENT', provider_message_id = $2, sent_at = NOW()
          WHERE id = $1`,
        [recipient.id, outcome.providerMessageId ?? null]
      );
    } else {
      failed += 1;
      await query(
        `UPDATE broadcast_recipients SET status = 'FAILED', error_detail = $2 WHERE id = $1`,
        [recipient.id, (outcome.error ?? 'Unknown error').slice(0, 500)]
      );
    }

    await query('UPDATE broadcasts SET sent_count = $2, failed_count = $3 WHERE id = $1', [
      broadcastId,
      sent,
      failed,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  await query(
    `UPDATE broadcasts
        SET status = $2, completed_at = NOW(), sent_count = $3, failed_count = $4
      WHERE id = $1`,
    [broadcastId, failed === pending.length && pending.length > 0 ? 'FAILED' : 'COMPLETED', sent, failed]
  );

  log.info({ broadcastId, sent, failed }, 'broadcast finished');
}

// --- contacts ---------------------------------------------------------------

templatesRouter.post(
  '/contacts',
  requireRole('ADMIN'),
  validate(
    z.object({
      wa_number: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 format, e.g. +919876543210.'),
      name: z.string().trim().max(120).optional(),
      opted_in: z.boolean().default(true),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { wa_number: number, name, opted_in: optedIn } = req.body;

    const row = await queryOne(
      `INSERT INTO contacts (tenant_id, wa_number, name, opted_in)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, wa_number) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, contacts.name), opted_in = EXCLUDED.opted_in
       RETURNING id, wa_number, name, opted_in, created_at`,
      [tenantId(req), number, name ?? null, optedIn]
    );

    created(res, row);
  })
);

/** Reads back a connection's token only to prove it decrypts; never returns it. */
export async function connectionHealth(tenant: string): Promise<boolean> {
  const row = await queryOne<{ access_token_encrypted: string }>(
    `SELECT access_token_encrypted FROM wa_connections
      WHERE tenant_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [tenant]
  );
  if (!row?.access_token_encrypted) return false;

  try {
    return decryptSecret(row.access_token_encrypted).length > 0;
  } catch {
    return false;
  }
}
