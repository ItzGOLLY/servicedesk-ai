/**
 * Plain-text formatting for outbound WhatsApp messages.
 *
 * WhatsApp is not a web page. It renders no Markdown, no HTML, no tables and no
 * bullet syntax — a heading written as "## Status" arrives literally as "##
 * Status". Everything the customer receives is therefore composed here, in the
 * small subset of formatting WhatsApp actually supports:
 *
 *     *bold*   _italic_   ~strikethrough~   ```monospace```
 *
 * Keeping every template in one file means the customer-facing voice is
 * consistent, and it is the only place to look when changing what a customer
 * reads.
 */
import type { TicketPriority, TicketStatus } from '../../types';

/** WhatsApp rejects messages beyond this length; long bodies are trimmed. */
const MAX_LENGTH = 4096;

/** Bold in WhatsApp is a single asterisk, not Markdown's double. */
export const bold = (text: string): string => `*${text}*`;

/**
 * Strips Markdown that would otherwise arrive as literal punctuation.
 *
 * Agents compose replies in a web textarea and naturally use Markdown habits —
 * **bold**, bullet lists, `code`. Sending that raw would look broken on a
 * phone, so it is converted to WhatsApp's own conventions or removed.
 */
export function toPlainText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    // fenced code blocks -> plain lines
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, (_, body) => String(body).trim())
    // images and links -> keep the visible text, then the URL in brackets
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // headings -> bold line
    .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => bold(String(t).trim()))
    // bold/italic -> WhatsApp equivalents
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/__([^_]+)__/g, '*$1*')
    // list markers -> a simple dash, which WhatsApp shows cleanly
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
    // inline code and blockquote markers
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    // horizontal rules add nothing in a chat
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    // collapse the blank-line runs Markdown encourages
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Appended when a message is trimmed; its length is reserved from the budget. */
const TRUNCATION_SUFFIX = '\n\n… (message truncated)';

/**
 * Trims to the provider limit on a word boundary rather than mid-word.
 *
 * The suffix length is subtracted from the budget rather than assumed, because
 * an over-length message is rejected outright by the provider — the result must
 * be guaranteed to fit, not merely close.
 */
export function truncate(text: string, max = MAX_LENGTH): string {
  if (text.length <= max) return text;

  const budget = max - TRUNCATION_SUFFIX.length;
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf('\n');
  const lastSpace = cut.lastIndexOf(' ');
  const at = lastBreak > budget - 400 ? lastBreak : lastSpace > 0 ? lastSpace : cut.length;

  return `${cut.slice(0, at).trimEnd()}${TRUNCATION_SUFFIX}`;
}

const SIGNATURE = '\n\n— ServiceDesk AI';

/** Statuses read to a customer, not as enum constants. */
const STATUS_TEXT: Record<TicketStatus, string> = {
  NEW: 'received',
  OPEN: 'open',
  IN_PROGRESS: 'being worked on',
  WAITING_FOR_CUSTOMER: 'waiting for your reply',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

const PRIORITY_TEXT: Record<TicketPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export interface TicketSummary {
  reference: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category?: string | null;
}

// --- templates -------------------------------------------------------------

/**
 * Sent immediately after a ticket is raised from a WhatsApp message.
 *
 * Priority and category are deliberately omitted. This message goes out before
 * classification has run — that ordering is what keeps ticket creation
 * independent of the AI service — so quoting either would tell the customer a
 * value that is about to change.
 */
export function ticketCreated(ticket: TicketSummary, firstName: string): string {
  return truncate(
    `Hi ${firstName}, thanks for getting in touch.\n\n` +
      `We have logged your request as ${bold(ticket.reference)}.\n\n` +
      `${bold('Subject')}: ${ticket.subject}\n` +
      `\nOne of our agents will look at this shortly. ` +
      `You can reply to this chat at any time to add more detail, ` +
      `and send ${bold('STATUS')} to check progress.` +
      SIGNATURE
  );
}

/** An agent's reply, delivered into the customer's chat. */
export function agentReply(ticket: TicketSummary, agentName: string, body: string): string {
  return truncate(
    `${bold(ticket.reference)} — reply from ${agentName}\n\n` +
      `${toPlainText(body)}\n\n` +
      `_Reply to this message to continue the conversation._` +
      SIGNATURE
  );
}

export function statusChanged(ticket: TicketSummary, to: TicketStatus): string {
  const closing =
    to === 'RESOLVED'
      ? `\n\nIf this is sorted, send ${bold('CLOSE')}. If the problem is still there, just reply and we will reopen it.`
      : to === 'WAITING_FOR_CUSTOMER'
        ? '\n\nWe need a little more information from you — please reply when you can.'
        : to === 'CLOSED'
          ? '\n\nThank you for contacting us.'
          : '';

  return truncate(
    `${bold(ticket.reference)} is now ${bold(STATUS_TEXT[to])}.\n\n` +
      `${bold('Subject')}: ${ticket.subject}` +
      closing +
      SIGNATURE
  );
}

/** Response to the STATUS keyword. */
export function statusSummary(tickets: TicketSummary[]): string {
  if (tickets.length === 0) {
    return truncate(
      `You have no open requests with us at the moment.\n\n` +
        `Send a message describing an issue and we will raise a new one.` +
        SIGNATURE
    );
  }

  const lines = tickets
    .map((t) => `${bold(t.reference)} — ${t.subject}\n   Status: ${STATUS_TEXT[t.status]}`)
    .join('\n\n');

  return truncate(
    `Here are your current requests:\n\n${lines}\n\n` +
      `Reply to this chat to add to the most recent one.` +
      SIGNATURE
  );
}

/** Response to HELP, and to anything we could not interpret. */
export function helpText(): string {
  return truncate(
    `${bold('ServiceDesk AI')}\n\n` +
      `Just describe your problem in a message and we will raise a support request for you.\n\n` +
      `${bold('Commands')}\n` +
      `- ${bold('STATUS')} — see your current requests\n` +
      `- ${bold('NEW')} — start a new request instead of adding to the last one\n` +
      `- ${bold('CLOSE')} — close your most recent resolved request\n` +
      `- ${bold('HELP')} — show this message` +
      SIGNATURE
  );
}

export function addedToTicket(ticket: TicketSummary): string {
  return truncate(
    `Thanks — we have added that to ${bold(ticket.reference)}.\n\n` +
      `An agent will see it with the rest of the conversation.` +
      SIGNATURE
  );
}

export function ticketClosed(ticket: TicketSummary): string {
  return truncate(
    `${bold(ticket.reference)} is now closed. Thank you for letting us know.\n\n` +
      `If you need anything else, just send a message.` +
      SIGNATURE
  );
}

/** Shown when the message is too short to be a useful ticket. */
export function tooShort(): string {
  return truncate(
    `Could you tell us a little more about the problem?\n\n` +
      `A sentence or two describing what happened helps us route it to the right person.` +
      SIGNATURE
  );
}
