export type UserRole = 'CUSTOMER' | 'AGENT' | 'ADMIN';

export type TicketStatus =
  | 'NEW'
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_CUSTOMER'
  | 'RESOLVED'
  | 'CLOSED';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type TicketSentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

// Makes req.user available to every handler after the auth middleware has run.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
