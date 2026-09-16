import { pool, closePool, query, queryOne } from './pool';
import { env } from '../config/env';
import { hashPassword } from '../utils/security';
import { classifyAndStore } from '../modules/tickets/tickets.service';
import { loggerFor } from '../observability/logger';

const log = loggerFor('seed');

/**
 * Creates demo data so the application is explorable immediately after deploy.
 *
 * Idempotent: every insert is guarded, so running it twice does not duplicate
 * anything. The tickets are realistic small-business complaints, which also
 * gives the AI classifier something meaningful to work on during a demo.
 */

const CATEGORIES = [
  ['Billing', 'Payments, invoices, refunds and subscription charges'],
  ['Technical', 'Errors, crashes and unexpected application behaviour'],
  ['Delivery', 'Orders, shipping, tracking and delivery issues'],
  ['Account', 'Login, passwords, profile and account access'],
  ['General', 'Anything that does not fit another category'],
];

const STAFF = [
  ['Priya Nair', 'priya.agent@servicedesk.ai', 'Agent@12345', 'AGENT'],
  ['Rahul Sharma', 'rahul.agent@servicedesk.ai', 'Agent@12345', 'AGENT'],
];

const CUSTOMERS = [
  ['Rohan Menon', 'rohan@example.com'],
  ['Sneha Iyer', 'sneha@example.com'],
  ['Arif Khan', 'arif@example.com'],
  ['Meera Rao', 'meera@example.com'],
];

const TICKETS: [string, string, string][] = [
  [
    'rohan@example.com',
    'Payment deducted but order still pending',
    'My payment of Rs 2,499 was deducted from my card yesterday but my order #4471 is still showing as pending. I have not received any confirmation email either. This is urgent as it was a gift.',
  ],
  [
    'sneha@example.com',
    'App crashes every time I open checkout',
    'The application crashes immediately when I tap the checkout button. I am on an Android device and I have already reinstalled the app twice. Nothing works.',
  ],
  [
    'arif@example.com',
    'Refund not credited after two weeks',
    'I returned my order on the 2nd and the pickup was completed, but the refund has still not been credited to my account. It has been more than two weeks now and this is very frustrating.',
  ],
  [
    'meera@example.com',
    'Cannot reset my password',
    'I clicked forgot password several times but I never receive the reset email. I have checked my spam folder. Could you please help me log in to my account?',
  ],
  [
    'rohan@example.com',
    'Wrong item delivered',
    'I ordered a blue medium shirt but received a red large one. The package and invoice both say blue medium, so something went wrong at dispatch.',
  ],
  [
    'sneha@example.com',
    'Question about invoice format',
    'I just wanted to ask whether you can add my company GST number to future invoices. No rush, thanks for the great service so far.',
  ],
];

async function seed(): Promise<void> {
  log.info('starting');

  // --- categories ---
  for (const [name, description] of CATEGORIES) {
    await query(
      `INSERT INTO categories (name, description) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [name, description]
    );
  }
  log.info(`categories ready (${CATEGORIES.length})`);

  // --- admin ---
  const adminHash = await hashPassword(env.seedAdminPassword);
  await query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, 'System Administrator', 'ADMIN')
     ON CONFLICT (email) DO NOTHING`,
    [env.seedAdminEmail, adminHash]
  );
  log.info(`admin ready (${env.seedAdminEmail})`);

  // --- agents ---
  for (const [fullName, email, password, role] of STAFF) {
    await query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4::user_role)
       ON CONFLICT (email) DO NOTHING`,
      [email, await hashPassword(password), fullName, role]
    );
  }
  log.info(`agents ready (${STAFF.length})`);

  // --- customers ---
  const customerHash = await hashPassword('Customer@12345');
  for (const [fullName, email] of CUSTOMERS) {
    await query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'CUSTOMER')
       ON CONFLICT (email) DO NOTHING`,
      [email, customerHash, fullName]
    );
  }
  log.info(`customers ready (${CUSTOMERS.length})`);

  // --- tickets ---
  const existing = await queryOne<{ count: string }>('SELECT COUNT(*)::TEXT AS count FROM tickets');
  if (Number(existing?.count ?? 0) > 0) {
    log.info('tickets already present — skipping');
    log.info('done');
    return;
  }

  const createdIds: string[] = [];
  for (const [email, subject, description] of TICKETS) {
    const customer = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (!customer) continue;

    const ticket = await queryOne<{ id: string }>(
      `INSERT INTO tickets (customer_id, subject, description, status)
       VALUES ($1, $2, $3, 'NEW') RETURNING id`,
      [customer.id, subject, description]
    );
    if (ticket) {
      createdIds.push(ticket.id);
      await query(
        `INSERT INTO ticket_events (ticket_id, actor_id, event_type, to_value)
         VALUES ($1, $2, 'CREATED', 'NEW')`,
        [ticket.id, customer.id]
      );
    }
  }
  log.info(`tickets created (${createdIds.length})`);

  // Classify sequentially so the console output stays readable and the AI
  // provider is not hit with six concurrent requests.
  for (const id of createdIds) {
    await classifyAndStore(id);
  }
  log.info('tickets classified');

  // Assign a couple so the agent dashboard is not empty on first login.
  const agent = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE email = 'priya.agent@servicedesk.ai'`
  );
  if (agent && createdIds.length >= 2) {
    await query(
      `UPDATE tickets SET assigned_agent_id = $1, status = 'IN_PROGRESS' WHERE id = ANY($2::UUID[])`,
      [agent.id, createdIds.slice(0, 2)]
    );
    log.info('sample tickets assigned');
  }

  log.info(
    {
      admin: env.seedAdminEmail,
      agent: 'priya.agent@servicedesk.ai',
      customer: 'rohan@example.com',
    },
    'seed complete - demo accounts created'
  );
}

seed()
  .then(() => closePool())
  .catch(async (error) => {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'seed failed');
    await closePool();
    process.exit(1);
  });
