import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { loginSchema, registerSchema } from '../modules/authentication/auth.schemas';
import {
  assignTicketSchema,
  createMessageSchema,
  createTicketSchema,
  listTicketsSchema,
  updateStatusSchema,
  updateTicketSchema,
} from '../modules/tickets/tickets.schemas';

// Teaches Zod to carry OpenAPI metadata, so the spec is generated from the
// same schemas that validate requests at runtime rather than maintained by
// hand alongside them. A schema change cannot silently desync the docs.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

/** Every successful response shares this envelope. */
const envelope = (data: z.ZodTypeAny) =>
  z.object({ success: z.literal(true), data }).openapi({ description: 'Success envelope' });

const errorSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z
        .array(z.object({ field: z.string(), message: z.string() }))
        .optional(),
    }),
  })
  .openapi('ErrorResponse');

const userSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    fullName: z.string(),
    role: z.enum(['CUSTOMER', 'AGENT', 'ADMIN']),
    isActive: z.boolean(),
  })
  .openapi('User');

const ticketSchema = z
  .object({
    id: z.string().uuid(),
    reference: z.string(),
    subject: z.string(),
    description: z.string(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    status: z.enum(['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED']),
    sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).nullable(),
    channel: z.enum(['WEB', 'WHATSAPP']),
    aiSummary: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Ticket');

const groundedAnswerSchema = z
  .object({
    answer: z.string(),
    insufficient: z.boolean().describe('True when the knowledge base did not cover the question'),
    sources: z.array(
      z.object({
        chunkId: z.string().uuid(),
        articleId: z.string().uuid(),
        title: z.string(),
        excerpt: z.string(),
        score: z.number(),
      })
    ),
    retrieval: z.object({
      candidates: z.number(),
      usedLexicalFallback: z.boolean().describe('True only when full-text search ran instead of vector search'),
      embeddingUsedFallback: z.boolean().describe('True when the offline embedder produced the query vector'),
      embeddingModel: z.string(),
      semantic: z.boolean(),
    }),
    usedFallback: z.boolean(),
  })
  .openapi('GroundedAnswer');

const errors = {
  400: { description: 'Validation failed', content: { 'application/json': { schema: errorSchema } } },
  401: { description: 'Not authenticated', content: { 'application/json': { schema: errorSchema } } },
  403: { description: 'Not permitted for this role', content: { 'application/json': { schema: errorSchema } } },
  404: { description: 'Not found, or hidden from this user', content: { 'application/json': { schema: errorSchema } } },
  422: { description: 'Valid request that breaks a business rule', content: { 'application/json': { schema: errorSchema } } },
};

const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

registry.registerPath({
  method: 'get', path: '/health', tags: ['Health'],
  summary: 'Process and database health',
  responses: {
    200: { description: 'Healthy', content: json(envelope(z.object({ status: z.string(), database: z.string() }))) },
    503: { description: 'Database unreachable', content: json(errorSchema) },
  },
});

registry.registerPath({
  method: 'post', path: '/auth/register', tags: ['Authentication'],
  summary: 'Create a Customer account',
  description: 'The role is always CUSTOMER; supplying a role field has no effect.',
  request: { body: { content: json(registerSchema) } },
  responses: {
    201: { description: 'Created', content: json(envelope(z.object({ user: userSchema, accessToken: z.string() }))) },
    ...errors,
  },
});

registry.registerPath({
  method: 'post', path: '/auth/login', tags: ['Authentication'],
  summary: 'Sign in',
  description:
    'Returns an access token and sets an httpOnly refresh cookie. An unknown email and a wrong password produce an identical response, so the endpoint cannot be used to enumerate accounts.',
  request: { body: { content: json(loginSchema) } },
  responses: {
    200: { description: 'Signed in', content: json(envelope(z.object({ user: userSchema, accessToken: z.string() }))) },
    ...errors,
  },
});

registry.registerPath({
  method: 'get', path: '/tickets', tags: ['Tickets'],
  summary: 'List tickets, scoped to the caller\'s role',
  description: 'A Customer only ever receives their own tickets, regardless of the filters supplied.',
  security: [{ [bearer.name]: [] }],
  request: { query: listTicketsSchema },
  responses: { 200: { description: 'Ticket page', content: json(envelope(z.array(ticketSchema))) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/tickets', tags: ['Tickets'],
  summary: 'Raise a ticket',
  description: 'Classification runs after the response is sent, so AI availability cannot affect ticket creation.',
  security: [{ [bearer.name]: [] }],
  request: { body: { content: json(createTicketSchema) } },
  responses: { 201: { description: 'Created', content: json(envelope(ticketSchema)) }, ...errors },
});

registry.registerPath({
  method: 'patch', path: '/tickets/{id}', tags: ['Tickets'],
  summary: 'Update subject, priority or category',
  security: [{ [bearer.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: json(updateTicketSchema) },
  },
  responses: { 200: { description: 'Updated', content: json(envelope(ticketSchema)) }, ...errors },
});

registry.registerPath({
  method: 'patch', path: '/tickets/{id}/status', tags: ['Tickets'],
  summary: 'Change status, validated against the lifecycle',
  description: 'An impermissible transition returns 422 naming the transitions that are allowed.',
  security: [{ [bearer.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: json(updateStatusSchema) },
  },
  responses: { 200: { description: 'Updated', content: json(envelope(ticketSchema)) }, ...errors },
});

registry.registerPath({
  method: 'patch', path: '/tickets/{id}/assign', tags: ['Tickets'],
  summary: 'Assign or unassign an agent',
  security: [{ [bearer.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: json(assignTicketSchema) },
  },
  responses: { 200: { description: 'Assigned', content: json(envelope(ticketSchema)) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/tickets/{id}/messages', tags: ['Tickets'],
  summary: 'Reply, or add a staff-only internal note',
  security: [{ [bearer.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: json(createMessageSchema) },
  },
  responses: { 201: { description: 'Created', content: json(envelope(z.object({ id: z.string().uuid() }))) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/ai/tickets/{id}/grounded-answer', tags: ['AI & RAG'],
  summary: 'Answer from the knowledge base, with citations',
  description:
    'Retrieves knowledge-base passages by vector similarity and answers strictly from them. Returns only the sources the answer actually cited. Sets insufficient=true rather than answering from model knowledge when the base does not cover the question.',
  security: [{ [bearer.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 200: { description: 'Grounded answer', content: json(envelope(groundedAnswerSchema)) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/knowledge', tags: ['Knowledge base'],
  summary: 'Create and index an article',
  description: 'Chunks and embeds synchronously, so the author knows immediately whether it is retrievable.',
  security: [{ [bearer.name]: [] }],
  request: {
    body: {
      content: json(
        z.object({
          title: z.string().min(4).max(200),
          body: z.string().min(30).max(20000),
          categoryId: z.string().uuid().nullable().optional(),
          isPublished: z.boolean().optional(),
        })
      ),
    },
  },
  responses: { 201: { description: 'Created and indexed', content: json(envelope(z.object({ id: z.string().uuid(), chunkCount: z.number() }))) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/knowledge/search', tags: ['Knowledge base'],
  summary: 'Vector similarity search over the knowledge base',
  security: [{ [bearer.name]: [] }],
  request: { body: { content: json(z.object({ query: z.string().min(3).max(1000), limit: z.number().int().min(1).max(10).optional() })) } },
  responses: { 200: { description: 'Ranked passages', content: json(envelope(z.object({ results: z.array(z.any()), usedLexicalFallback: z.boolean() }))) }, ...errors },
});

registry.registerPath({
  method: 'post', path: '/whatsapp/webhook', tags: ['WhatsApp'],
  summary: 'Inbound WhatsApp messages from the provider',
  description:
    'Public but signature-verified. Always returns 200, because providers retry non-2xx responses and an unprocessable message would retry forever. Idempotent on the provider message id.',
  responses: {
    200: { description: 'Accepted (whether or not it was actionable)', content: json(envelope(z.object({ processed: z.number() }))) },
    403: { description: 'Invalid signature', content: json(errorSchema) },
  },
});

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'ServiceDesk AI API',
      version: '1.0.0',
      description:
        'Multi-channel customer support platform. Tickets arrive from WhatsApp or the web, are triaged with LLM assistance that degrades to a deterministic classifier, and can be answered from a pgvector-backed knowledge base with citations.\n\nAuthentication uses a short-lived bearer access token plus an httpOnly refresh cookie. Authorization is enforced in two layers: a role check on the route and an ownership check on the record.',
    },
    servers: [
      { url: 'http://localhost:4000/api', description: 'Local' },
      { url: 'http://localhost:8080/api', description: 'Docker Compose' },
    ],
    tags: [
      { name: 'Health' }, { name: 'Authentication' }, { name: 'Tickets' },
      { name: 'AI & RAG' }, { name: 'Knowledge base' }, { name: 'WhatsApp' },
    ],
  });
}
