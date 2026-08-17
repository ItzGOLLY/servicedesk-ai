import { z } from 'zod';

const STATUSES = [
  'NEW',
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;

export const createTicketSchema = z.object({
  subject: z.string().trim().min(5, 'Subject must be at least 5 characters.').max(200),
  description: z.string().trim().min(10, 'Please describe the issue in at least 10 characters.').max(5000),
  categoryId: z.string().uuid('Category is not a valid identifier.').optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
});

export const updateTicketSchema = z
  .object({
    subject: z.string().trim().min(5).max(200).optional(),
    priority: z.enum(PRIORITIES).optional(),
    categoryId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const updateStatusSchema = z.object({
  status: z.enum(STATUSES),
});

export const assignTicketSchema = z.object({
  // null unassigns the ticket and returns it to the queue.
  agentId: z.string().uuid('Agent is not a valid identifier.').nullable(),
});

export const createMessageSchema = z.object({
  body: z.string().trim().min(1, 'A message cannot be empty.').max(5000),
  isInternalNote: z.boolean().optional().default(false),
  aiAssisted: z.boolean().optional().default(false),
});

/**
 * Query filters. Everything arrives as a string, so each field is coerced here
 * and handlers can treat page/limit as real numbers.
 */
export const listTicketsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  sentiment: z.enum(SENTIMENTS).optional(),
  categoryId: z.string().uuid().optional(),
  agentId: z.union([z.string().uuid(), z.literal('unassigned')]).optional(),
  customerId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['createdAt', 'updatedAt', 'priority', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type ListTicketsQuery = z.infer<typeof listTicketsSchema>;
