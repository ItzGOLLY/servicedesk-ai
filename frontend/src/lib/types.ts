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

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface Ticket {
  id: string;
  reference: string;
  subject: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  sentiment: TicketSentiment | null;
  aiSummary: string | null;
  aiConfidence: number | null;
  aiClassifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  customer: { id: string; name: string; email: string };
  agent: { id: string; name: string | null } | null;
  category: { id: string; name: string | null } | null;
}

export interface TicketMessage {
  id: string;
  body: string;
  isInternalNote: boolean;
  aiAssisted: boolean;
  createdAt: string;
  author: { id: string; name: string | null; role: string };
}

export interface TicketEvent {
  id: string;
  type: string;
  from: string | null;
  to: string | null;
  actor: string | null;
  createdAt: string;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  ticketCount?: number;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  ticketId: string | null;
  ticketReference: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
  actor: { name: string; email: string } | null;
}

export interface LabelCount {
  label: string;
  count: number;
}

export interface AdminDashboard {
  metrics: {
    totalTickets: number;
    openTickets: number;
    resolvedTickets: number;
    unassignedTickets: number;
    activeCustomers: number;
    activeAgents: number;
    averageResolutionHours: number | null;
  };
  byStatus: LabelCount[];
  byPriority: LabelCount[];
  byCategory: LabelCount[];
  bySentiment: LabelCount[];
  agentWorkload: { name: string; open: number; resolved: number }[];
  trend: { day: string; count: number }[];
  ai: { ticketsClassified: number; suggestionsFromFallback: number; aiAssistedReplies: number };
}

export interface AgentDashboard {
  metrics: {
    assigned: number;
    open: number;
    highPriority: number;
    resolved: number;
    unassignedInQueue: number;
    averageResolutionHours: number | null;
  };
  byCategory: { name: string; count: number }[];
  queue: {
    id: string;
    reference: string;
    subject: string;
    status: TicketStatus;
    priority: TicketPriority;
    customerName: string;
    createdAt: string;
  }[];
}

export interface CustomerDashboard {
  metrics: { total: number; open: number; resolved: number; awaitingYourReply: number };
  recentTickets: {
    id: string;
    reference: string;
    subject: string;
    status: TicketStatus;
    priority: TicketPriority;
    createdAt: string;
  }[];
}
