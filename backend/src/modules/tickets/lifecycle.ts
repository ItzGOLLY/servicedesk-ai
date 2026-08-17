import type { TicketStatus, UserRole } from '../../types';

/**
 * The ticket lifecycle, defined in exactly one place.
 *
 * Keeping the transition table here rather than scattering `if (status === ...)`
 * checks across handlers means the rules can be read, tested and explained as a
 * single unit — and the API cannot be tricked into an impossible state by
 * calling endpoints in an unusual order.
 */
export const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'OPEN'], // reopened when the customer says it persists
  CLOSED: ['OPEN'], // admin-only, see below
};

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Answers whether `role` may move a ticket from `from` to `to`.
 *
 * Two independent questions are asked: is the transition valid at all, and is
 * this role permitted to make it.
 */
export function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  role: UserRole
): TransitionCheck {
  if (from === to) {
    return { allowed: false, reason: `The ticket is already ${from}.` };
  }

  if (!TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      reason: `A ticket cannot move from ${from} to ${to}. Allowed: ${
        TRANSITIONS[from].join(', ') || 'none'
      }.`,
    };
  }

  // Reopening a closed ticket is an administrative correction, not routine work.
  if (from === 'CLOSED' && role !== 'ADMIN') {
    return { allowed: false, reason: 'Only an administrator can reopen a closed ticket.' };
  }

  // A customer drives only two transitions: confirming a fix, and saying it did
  // not work. Everything else belongs to staff.
  if (role === 'CUSTOMER') {
    const customerAllowed =
      (from === 'RESOLVED' && to === 'CLOSED') || (from === 'RESOLVED' && to === 'OPEN');
    if (!customerAllowed) {
      return {
        allowed: false,
        reason: 'A customer may only close a resolved ticket or reopen it if the issue persists.',
      };
    }
  }

  return { allowed: true };
}

/**
 * Timestamp columns that must change alongside a status.
 * Returned as data so the caller can apply them in the same UPDATE.
 */
export function timestampsForStatus(to: TicketStatus): {
  resolvedAt: 'NOW' | 'NULL' | 'KEEP';
  closedAt: 'NOW' | 'NULL' | 'KEEP';
} {
  switch (to) {
    case 'RESOLVED':
      return { resolvedAt: 'NOW', closedAt: 'NULL' };
    case 'CLOSED':
      return { resolvedAt: 'KEEP', closedAt: 'NOW' };
    // Moving back into an active state clears both, satisfying the database
    // constraint that only resolved or closed tickets carry a resolved_at.
    default:
      return { resolvedAt: 'NULL', closedAt: 'NULL' };
  }
}
