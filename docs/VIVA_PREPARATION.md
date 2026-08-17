# Viva Preparation

The course guidelines state that students must understand every line of submitted code and may be asked to explain or modify the implementation during evaluation. This document is a study aid, not a substitute for reading the code. **Before the review, both of you should open each file named below and follow what it does.**

---

## Cloud Computing

**Why is this cloud-native rather than just a web application?**
Nothing runs on a machine we own or administer. The database is a managed service with its own backups; the API is a stateless container the platform can replicate; the frontend is static content on a global CDN. All three tiers scale and deploy independently, and the application is reachable from any browser on the public internet. A traditional web application would be one process on one server that we patch ourselves.

**What is SaaS, and why is this SaaS?**
Software as a Service: software delivered over the internet as a centrally hosted, multi-user service, with no installation on the client. A small business signs in through a browser and uses our support desk. They do not install anything, do not run a server, and do not manage upgrades.

**Where are the other service models in your project?**
PaaS — Vercel and Render: we supply code, they manage runtime, scaling and TLS. DBaaS — Supabase: managed PostgreSQL. Our own product sits at the SaaS layer on top.

**Why use a cloud database rather than a local one?**
A local database is reachable only from the machine it runs on, so the deployed API could not use it. The managed instance gives us availability, automated backups, connection pooling and TLS without anyone administering a server — and it is the shared source of truth if the API runs as several replicas.

**What makes it multi-user?**
Three roles share one deployment and one database, isolated by row-level scoping in the API. Any number of customers can hold sessions simultaneously; each sees only their own tickets because every customer query is narrowed to `customer_id = <current user>` in `buildFilters()`.

**Why REST APIs?**
They give a clear contract between tiers over ordinary HTTP, so the frontend can be deployed, scaled and replaced independently of the backend. Statelessness is what makes horizontal scaling possible. Resources map naturally onto our domain, and the methods carry meaning: `GET /tickets`, `POST /tickets`, `PATCH /tickets/:id/status`.

**How is the frontend connected to the backend?**
The browser calls the API over HTTPS with a JSON body and an `Authorization: Bearer` header. All of it goes through one wrapper, `frontend/src/lib/api.ts`. The frontend never touches the database.

**How is scalability addressed?**
The API stores no session state — sessions are JWTs and everything else is in PostgreSQL. That single property lets the platform run N replicas with no sticky sessions. Add bounded connection pooling per instance, server-side pagination so responses do not grow with the dataset, and a CDN frontend that scales independently.

**How is availability addressed?**
Managed services with platform-level redundancy; `/api/health` checks the process *and* the database so a half-broken instance is reported unhealthy; `SIGTERM` triggers graceful shutdown so redeploys do not drop requests; and the AI dependency degrades to a local fallback instead of failing.

**Why this deployment architecture and not something bigger?**
It is the simplest architecture that satisfies every requirement. Microservices, Kubernetes or a message queue would add failure modes and operational burden with no benefit at this scale — and we would have to justify complexity that solves no problem we have.

**What are the limits of your free tier?**
Render free instances sleep after ~15 minutes idle, so the first request takes about 50 seconds; Supabase pauses a project after ~7 days idle. A scheduled ping to `/api/health` every 10 minutes addresses both, because that endpoint queries the database.

---

## Database

**Why PostgreSQL?**
The domain is relational — a ticket belongs to one customer, may be assigned to one agent, and owns many messages. Foreign keys let the database itself refuse an orphaned ticket. PostgreSQL adds enums for our fixed vocabularies, `CHECK` constraints for business invariants, full-text search without a separate service, and `JSONB` for the genuinely variable audit metadata.

**What are the entities?**
`users`, `categories`, `tickets`, `ticket_messages`, `ticket_events`, `ai_suggestions`, `notifications`, `audit_logs`.

**Why is `tickets` joined to `users` twice?**
`customer_id` and `assigned_agent_id` both reference `users`, so every ticket query joins that table under two aliases — `cu` for the customer, `ag` for the agent.

**Why one `users` table instead of three?**
A person is a person; role is an attribute. Three tables would duplicate every authentication column three times and turn "change this user's role" into a delete-and-recreate rather than one `UPDATE`.

**Why enums rather than lookup tables for role and status?**
The values are fixed by the specification and never edited at runtime. An enum gives the same integrity guarantee with one fewer join, and makes an invalid value impossible to insert. Declaration order also gives us free correct sorting — `ticket_priority` sorts `LOW < MEDIUM < HIGH < URGENT`, so `ORDER BY priority DESC` puts urgent work at the top of the queue.

**What are your primary and foreign keys?**
Every table has a UUID primary key from `gen_random_uuid()`. Foreign keys: `tickets.customer_id` and `tickets.assigned_agent_id` → `users.id`; `tickets.category_id` → `categories.id`; `ticket_messages.ticket_id` and `ticket_events.ticket_id` → `tickets.id`; and so on.

**Why UUIDs and not auto-incrementing integers?**
Sequential integers leak information — ticket 1042 tells you the business has had roughly a thousand tickets, and they are trivially enumerable. UUIDs are unguessable. We keep a readable `SD-nnnn` reference alongside for humans, but the API always uses the UUID.

**Why do different foreign keys have different delete rules?**
Each answers what should happen to real data. `customer_id` is `RESTRICT`: deleting a customer with tickets would destroy the support history, so admins deactivate instead. `assigned_agent_id` is `SET NULL`: if an agent leaves, their tickets return to the unassigned queue rather than vanishing. Messages and events are `CASCADE`: they have no meaning without their ticket.

**What database-level constraints do you have and why?**
Beyond keys and uniqueness: not-blank checks on names and ticket text, a 0–1 range on `ai_confidence`, and two consistency constraints — `resolved_at` may only be set when the status is `RESOLVED` or `CLOSED`, and `closed_at` only when `CLOSED`. Those two are why reopening a ticket clears its timestamps; the database would reject the row otherwise. The invariant holds even if application code is wrong.

**How is your data indexed?**
Every column used for filtering: customer, agent, category, status, priority, sentiment, and `created_at DESC` for ordering. A GIN index on `to_tsvector(subject || ' ' || description)` backs keyword search. Composite indexes where queries are always compound — `(ticket_id, created_at)` for a thread, `(user_id, is_read, created_at DESC)` for the notification badge.

**Is your schema normalised?**
Third normal form. One deliberate exception: `first_response_at` and `resolved_at` are stored on `tickets` although they are derivable from the event log, because average resolution time appears on three dashboards and recomputing it per page load would mean an aggregate scan every time. That is a considered trade-off.

**How do you manage schema changes?**
Numbered SQL migration files applied in order by `npm run migrate`. A `schema_migrations` table records what has run, each migration runs in a transaction, and the command is safe to repeat. The ER diagram is derived from those files, so the diagram cannot describe a database that does not exist.

**How is the data protected?**
TLS in transit; managed backups at rest; parameterised queries everywhere so no user input reaches SQL as text; the API as the only client, so no browser holds a database credential.

---

## Security

**How are passwords stored?**
As bcrypt hashes at cost factor 12 — roughly 250 ms per hash, expensive enough to make offline brute force impractical, fast enough that login stays responsive. bcrypt salts each hash automatically, so two users with the same password have different hashes. `verifyPassword` compares in constant time. Test A-03 asserts the stored value is a `$2` hash and not the plaintext.

**Why two tokens?**
They defend against different threats. The access token is short-lived (15 min) and held in a JavaScript variable — never `localStorage` — so an injected script cannot steal a long-lived credential. The refresh token is long-lived (7 days) in an `httpOnly` cookie, which JavaScript cannot read at all, scoped to `/api/auth` so it is only transmitted where it is needed.

**How is RBAC implemented?**
Two independent server-side layers. `requireRole()` middleware answers "may this role call this endpoint?"; inside the handler, `getTicketForUser()` answers "does this record belong to this user?". Both are necessary — middleware cannot know whether ticket X belongs to customer Y.

**Prove that hiding buttons is not your security.**
`tests/authorization.test.ts` — 26 tests that call the API directly with a valid token for the wrong role, bypassing the interface entirely. A customer requesting the admin dashboard gets `403`; requesting another customer's ticket gets `404`.

**Why 404 and not 403 for another customer's ticket?**
`403` would confirm the ticket exists. Returning `404` means an attacker cannot probe identifiers to learn what is in the system.

**Why is the login error message the same for an unknown email and a wrong password?**
Different messages would let anyone test whether an address is registered. Test A-08 asserts the two responses are identical. We also still run a hash when the email is unknown, so response timing does not leak the answer either.

**Where are secrets stored?**
Environment variables only — on Render for the backend, and nothing secret on Vercel. `.env` is gitignored and no secret has been committed. `config/env.ts` fails at boot if a required variable is missing, rather than at the first request.

**How do you know the AI key is not in the frontend?**
The key is read only by `services/ai/anthropic.provider.ts`, which runs on the server. The browser calls our own `/api/ai/*` routes. Only `VITE_`-prefixed variables enter the bundle, and the only one is the API base URL. You can verify it: `curl <vercel-url>/assets/index-*.js | grep sk-` returns nothing.

**How do you prevent SQL injection?**
Every query is parameterised — values go through `$1, $2` placeholders and never into the SQL string. The one place a variable enters SQL text is the sort column, and it comes from a fixed allow-list map, never from raw input.

**What else?**
Zod validation on every request body and query string; Helmet security headers; CORS restricted to an explicit origin allow-list (a wildcard is impossible because we send credentials); rate limiting on login and registration; and an error handler that never returns a stack trace or a raw PostgreSQL message.

**What happens if an admin deactivates someone who is signed in?**
Access stops immediately. The auth middleware re-reads the user row on every request rather than trusting the token's claims, so an unexpired token on a deactivated account gets `403`. Test A-13 covers exactly this.

---

## AI

**What exactly does the AI do?**
Four things, all advisory. On submission it proposes a category, priority and sentiment and writes a one-line summary. On request it drafts a reply for an agent, summarises a long conversation, and suggests troubleshooting steps.

**Be honest — was AI required?**
No. The official Project 19 specification does not mention AI; only the project title contains it. Every AI capability is our own addition, and we designed the system so that **no mandatory requirement depends on it**.

**Why is AI genuinely useful here rather than decorative?**
A small business has no dedicated triage person. Without classification, tickets sit in an undifferentiated list and an urgent billing failure looks the same as a formatting question. The classifier orders the queue, and the draft reply removes the blank-page delay on a first response.

**What happens if the AI fails?**
Nothing user-visible breaks. Classification runs *after* the ticket row is committed and is not awaited by the create handler, so ticket creation cannot fail or slow down. Any provider failure — network error, timeout, rate limit, malformed JSON — converges on a deterministic rule-based classifier that runs locally. The result carries a `usedFallback` flag that reaches the database and is shown to the agent. CRUD, dashboards, reports and notifications are entirely unaffected. Test AI-11 proves it.

**Show me the fallback is real, not a stub.**
`services/ai/fallback.provider.ts` is a working keyword classifier with category keyword sets, priority and sentiment term lists, and per-category troubleshooting playbooks. The entire application is developable and demonstrable with no API key at all — which is how the seeded data was classified.

**Why must AI-generated responses require agent review?**
Two reasons. Correctness: a model can state something confidently that is wrong about *this* customer's order, and a wrong promise about a refund is a real commercial problem. Accountability: a human should own what the business says to a customer. So the AI writes into a draft box the agent must explicitly insert, edit and send — there is no code path in which AI text reaches a customer without a person pressing send. Test AI-12 asserts that generating a draft creates zero customer-visible messages.

**How is the AI integrated into the cloud architecture?**
As a service layer inside the application tier, never a separate deployable. Routes call `services/ai/`, which selects a provider behind the `AiProvider` interface. Only that layer makes the outbound HTTPS call, with an `AbortController` timeout so a slow provider cannot hold a connection open and exhaust the pool.

**How do you stop the model inventing facts?**
The system prompt forbids promising refunds, compensation or delivery dates, and forbids inventing order details or policies. Beyond that we validate structurally: the returned category must match one the business has configured, and priority and sentiment must be valid enum values or they fall back to safe defaults. And the agent reviews everything.

**Why doesn't the AI overwrite a category the customer chose?**
`COALESCE(category_id, $4)` — the classifier only fills a category that is still empty. A customer's explicit choice always wins over a guess. Test AI-10 covers it.

---

## Project

**Explain the complete workflow.**
A customer registers and raises a ticket. It is stored with status `NEW` and a reference like `SD-1024`, and the response returns immediately. Classification then runs in the background and fills in category, priority, sentiment and summary. The ticket appears in the agent queue, ordered by priority. An agent assigns it — which moves it to `OPEN` — opens the AI panel, generates a draft, edits it and sends it, which sets the first-response time and moves the ticket to `IN_PROGRESS`. The customer is notified and can reply. When fixed, the agent resolves it; the customer confirms by closing it, or reopens it if the problem persists. Every step writes a timeline event, and every privileged action writes an audit entry, which is what feeds the admin dashboards.

**Explain the ticket lifecycle.**
Six states: `NEW → OPEN → IN_PROGRESS → RESOLVED → CLOSED`, with `WAITING_FOR_CUSTOMER` as a branch when the agent needs more information. Permitted transitions live in one table in `modules/tickets/lifecycle.ts` and are validated on every change, so an invalid transition returns `422` rather than being silently applied. Reopening a closed ticket is admin-only; a customer may only close or reopen a resolved ticket.

**Explain each role.**
Customer: raises tickets, sees only their own, replies and tracks status. Agent: works the queue across all customers, updates status, priority, category and assignment, replies, adds staff-only internal notes, and uses AI assistance. Admin: everything an agent can do, plus managing users, roles, categories, reports and the audit log — and cannot demote or deactivate themselves, which prevents lock-out.

**Why did you name the backend folders that way?**
They match the Suggested Modules in the Project 19 specification — Authentication, User Management, Core Business Module, Reports & Analytics, Administration — so the mapping from requirement to code is visible in the repository tree.

**How do you know the dashboards are not showing fake numbers?**
Every figure is a SQL aggregate executed at request time in `modules/reports/dashboard.routes.ts`. There is no hard-coded dashboard value anywhere. You can prove it live: create a ticket, reload the admin dashboard, and watch the total change.

**Did you find any bugs, and how?**
Yes, and both were caught rather than shipped. The test suite exposed that the login rate limiter was throttling automated runs. Manual browser verification exposed that every Recharts series rendered invisibly — axes and legends drew, but no bars, areas or pie slices — because the enter animation does not settle under React 18 StrictMode. Fixed with `isAnimationActive={false}`. That is why we looked at the running application instead of trusting that the build succeeded.

**What was hardest?**
Getting graceful degradation genuinely right. It is easy to write a `try/catch` and claim resilience; it is harder to design so that the failure cannot matter — which meant moving classification *after* the database commit and off the response path, and building a fallback good enough to demonstrate with.

**Explain your contribution.**
*Answer this yourselves.* Be specific about modules you wrote, decisions you made, and bugs you fixed. Rotate ownership before the review so both of you can speak to the backend, the frontend and the database.

**What would you improve next?**
Email notifications so customers learn of updates without signing in; file attachments via cloud object storage, since screenshots make technical issues far faster to diagnose; configurable SLA targets with escalation; and WebSockets to replace the polling that currently drives the notification badge.

---

## Likely "modify it now" requests

Faculty may ask you to change something live. Rehearse these.

| Request | Where to go | What to change |
|---|---|---|
| Add a ticket status | `backend/src/db/migrations/` (new migration adding the enum value), `lifecycle.ts` (transition table), `frontend/src/lib/format.ts` (badge colour) | Three files — the lifecycle table is the important one |
| Change the password policy | `backend/src/modules/authentication/auth.schemas.ts` | One Zod schema; it applies to registration and password change together |
| Add a dashboard metric | `backend/src/modules/reports/dashboard.routes.ts`, then `frontend/src/lib/types.ts` and the dashboard page | Add the SQL aggregate, extend the type, render a `StatTile` |
| Let agents delete tickets | `backend/src/modules/tickets/tickets.routes.ts` | Change `requireRole('ADMIN')` to `requireRole('AGENT', 'ADMIN')` — and note the authorization test would then need updating |
| Change the AI model | Render environment variable `AI_MODEL` | No code change; the provider reads it from config |
| Turn AI off completely | Set `AI_PROVIDER=fallback` | The application keeps working; the panel says the fallback is in use |
| Add a filter to the queue | `tickets.schemas.ts` (accept the parameter), `tickets.service.ts` (`buildFilters`), `TicketList.tsx` (the control) | Three edits, following the existing pattern for `sentiment` |
