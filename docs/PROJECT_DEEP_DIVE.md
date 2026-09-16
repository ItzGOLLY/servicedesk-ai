# ServiceDesk AI — Project Deep Dive

**This document is for you, not for recruiters.** It explains the actual final
codebase so you can defend every part of it.

Everything here was verified against the code on the date of writing. Anything
that could not be verified is marked **NOT VERIFIED**.

---

## 20A. Project overview

### What it is

A customer support platform where complaints arrive from **WhatsApp or the web**,
become tracked tickets, are triaged with **LLM assistance that degrades to a
deterministic classifier**, and can be answered from a **pgvector-backed
knowledge base with citations**.

### Who uses it

| Role | What they do |
|---|---|
| **Customer** | Raises tickets from WhatsApp or the web; sees only their own |
| **Support Agent** | Works a prioritised queue across all customers; uses AI assistance |
| **Admin** | Everything an agent can do, plus users, roles, categories, knowledge base, reports, audit log |

### Why WhatsApp and web

A small business's customers already use WhatsApp. A portal they must sign into
is the friction that made complaints go missing in the first place. The web app
is where **staff** work; WhatsApp is where **customers** are.

### Where AI is used, and where it is not

| Automated | Human-controlled |
|---|---|
| Category, priority, sentiment, summary on arrival | Sending any reply to a customer |
| Retrieval of relevant knowledge passages | Accepting or editing a drafted reply |
| Ticket reference generation, status advancement on reply | Status transitions, assignment |
| Notifications, audit entries | Article authoring and publication |

**No AI output ever reaches a customer without an agent pressing send.**

### 30-second explanation

> ServiceDesk AI is a multi-channel support platform. Customers message on
> WhatsApp or use the web app; every message becomes a tracked ticket that gets
> classified automatically. Agents work from one queue and can generate a reply
> grounded in our knowledge base, with citations, before sending it. It's a
> TypeScript monolith on PostgreSQL, containerised, with the AI layer designed
> so that if the model provider goes down, everything still works.

### 2-minute explanation

> The problem is that a small business receiving complaints across WhatsApp,
> email and phone has no record of what was reported, who owns it, or whether it
> was resolved. Commercial helpdesks solve this but are priced per agent.
>
> The system has three tiers: a React SPA, a stateless Express REST API, and
> PostgreSQL. Customers can raise a ticket by sending a WhatsApp message — no
> signup. The webhook is HMAC-verified and idempotent on the provider's message
> id, because providers retry and a duplicate would otherwise create a second
> ticket.
>
> On arrival a ticket is classified for category, priority and sentiment. That
> runs *after* the database commit and is never awaited, so if the AI provider
> is slow or down, ticket creation is unaffected. Every AI failure path converges
> on a deterministic keyword classifier, and the result records which engine ran
> so the dashboards stay honest.
>
> Agents can ask for an answer grounded in the knowledge base. Articles are
> chunked, embedded and stored in pgvector; retrieval is cosine similarity with a
> full-text fallback. The model answers only from retrieved passages and returns
> citations, which are filtered against the passages actually supplied so a
> hallucinated source can't appear real.
>
> Authorization is enforced in two layers — a role check on the route and an
> ownership check on the record — and 26 tests verify it by calling the API
> directly with the wrong role, bypassing the UI entirely.

### 5-minute technical explanation

Add to the above:

- **Data model.** 12 tables. Business invariants are CHECK constraints, not
  application code — `resolved_at` can only be set when status is RESOLVED or
  CLOSED, which is why reopening clears it. FK delete rules differ per
  relationship: customer is RESTRICT (deleting would destroy history), assigned
  agent is SET NULL (tickets return to the queue).
- **Lifecycle.** Six states, transitions defined in one table consulted on every
  change. An invalid transition returns 422 naming what *is* allowed.
- **Transactions.** Status change and assignment write the ticket row and its
  timeline event inside one transaction, so the audit trail cannot diverge.
- **Retrieval.** Chunks carry the article title so orphan passages stay findable.
  HNSW index, not IVFFlat — see §20N for the bug that caused.
- **Observability.** pino structured logging, per-request ids echoed as
  `X-Request-Id`, secrets redacted at the logger.
- **Testing.** 153 tests against a real PostgreSQL using production migrations.
- **Evaluation.** 30 labelled tickets, `npm run eval`, measured numbers.

---

## 20B. Complete architecture

```
                        ┌─────────────────────────┐
   Customer's phone ───▶│  WhatsApp (Twilio)      │
                        └───────────┬─────────────┘
                                    │ POST webhook (HMAC-signed)
                                    ▼
┌──────────────┐   HTTPS   ┌──────────────────────────────────────┐
│  Browser     │──────────▶│  Express REST API  (stateless)       │
│  React SPA   │◀──────────│  ────────────────────────────────    │
│  nginx :8080 │  JSON     │  httpLogger → helmet → cors → json   │
└──────────────┘           │   → rateLimit → requireAuth          │
                           │   → requireRole → zod → handler      │
                           │                                       │
                           │  modules/  auth · users · tickets     │
                           │            reports · admin · ai       │
                           │            whatsapp · knowledge       │
                           │                                       │
                           │  services/ ai/        ─┬─ anthropic   │
                           │            embeddings/ ├─ openai      │
                           │            whatsapp/   └─ fallbacks   │
                           └────────────────┬─────────────────────┘
                                            │ pooled TLS
                                            ▼
                           ┌──────────────────────────────────────┐
                           │  PostgreSQL 16 + pgvector            │
                           │  12 tables · enums · CHECK           │
                           │  GIN full-text · HNSW vector index   │
                           └──────────────────────────────────────┘
```

### Component reference

| Component | What it does | Key file | Failure mode | Fallback |
|---|---|---|---|---|
| **Frontend** | Renders, routes, holds access token in memory | `frontend/src/App.tsx` | API unreachable | "Cannot reach server" + retry |
| **httpLogger** | Request id, method, status, duration | `src/observability/httpLogger.ts` | — | — |
| **requireAuth** | Verifies JWT, **re-reads user row** | `src/middleware/auth.ts` | Expired token | 401 → client refreshes once |
| **requireRole** | Route-level role gate | `src/middleware/rbac.ts` | Wrong role | 403 |
| **validate** | Zod parse, replaces request part | `src/middleware/validate.ts` | Bad shape | 400 + field errors |
| **errorHandler** | Single error→HTTP boundary | `src/middleware/errorHandler.ts` | Any throw | Typed envelope, never a stack trace |
| **lifecycle** | Transition table + role rules | `src/modules/tickets/lifecycle.ts` | Illegal transition | 422 with allowed list |
| **AI adapter** | Selects provider, converges failures | `src/services/ai/index.ts` | Timeout/500/bad JSON | Deterministic classifier, `usedFallback=true` |
| **Embeddings** | Vectorises text | `src/services/embeddings/index.ts` | Provider down | Local lexical vectors |
| **Knowledge** | Chunk, index, retrieve | `src/modules/knowledge/knowledge.service.ts` | No embeddings | PostgreSQL full-text search |
| **WhatsApp** | Inbound + outbound | `src/services/whatsapp/index.ts` | Send fails | Recorded FAILED + admins notified |
| **Database** | Storage + invariants | `src/db/migrations/*.sql` | Unreachable | `/api/health` returns 503 |

---

## 20C. Repository map

```
backend/src/
  config/env.ts            Validated env. Throws at BOOT if a required var is missing.
  observability/           pino logger + per-request http logger
  db/
    pool.ts                Pool, query(), queryOne(), withTransaction()
    migrate.ts             Runs .sql files once each, tracked in schema_migrations
    seed.ts                Demo data (idempotent)
    migrations/            001 core · 002 whatsapp · 003 knowledge · 004 hnsw
  middleware/              auth · rbac · validate · errorHandler
  modules/
    authentication/        register, login, refresh, logout, me
    user-management/       profile + admin user ops
    tickets/
      lifecycle.ts         ◀── the transition table. Read this first.
      tickets.service.ts   Queries, ROLE SCOPING, classification trigger
      tickets.routes.ts    HTTP layer + side effects
    knowledge/
      knowledge.service.ts ◀── chunking, indexing, retrieval
      knowledge.routes.ts  Article CRUD + search
    ai/ai.routes.ts        draft-reply · summary · steps · grounded-answer
    whatsapp/              webhook + inbound conversation logic
    reports/               dashboards + reports
    administration/        categories + audit log
  services/
    ai/                    types · anthropic · fallback · index (adapter)
    embeddings/            types · openai · deterministic · index (adapter)
    whatsapp/              types · twilio · simulator · format · index
  openapi/spec.ts          OpenAPI generated from the Zod schemas
  app.ts                   Middleware chain + route mounting
  server.ts                Boot, DB check, graceful shutdown
eval/
  dataset.json             30 hand-labelled tickets + 3 KB articles
  run.ts                   Measurement harness (npm run eval)
```

**Files you would actually modify:** `lifecycle.ts` (workflow rules),
`tickets.service.ts` (query scoping), `knowledge.service.ts` (chunk size, top-k),
`services/*/index.ts` (provider selection), `env.ts` (new config).

---

## 20D. Complete user journeys

### Registration
```
Register form (pages/Register.tsx)
 → POST /api/auth/register
 → httpLogger → helmet → cors → rateLimit(20/15min) → validate(registerSchema)
 → handler: check email exists → 409 if so
 → hashPassword() bcrypt cost 12
 → INSERT users (role forced to 'CUSTOMER' — request body cannot escalate)
 → signAccessToken + setRefreshCookie(httpOnly)
 → recordAudit('USER_REGISTERED')
 → 201 { user, accessToken }
 → AuthContext stores token IN MEMORY → navigate to /dashboard
SAVED: one users row (bcrypt hash), one audit_logs row
```

### Login
```
POST /api/auth/login → SELECT user by email
 → bcrypt.compare. If email unknown, STILL hash (constant-ish timing)
 → identical 401 message for unknown-email and wrong-password
 → if !is_active → 403
 → access token (15 min) + refresh cookie (7 d, httpOnly, path=/api/auth)
```

### Refresh (invisible to the user)
```
Any request → 401
 → lib/api.ts refreshes ONCE: POST /api/auth/refresh (cookie sent automatically)
 → new access token → ORIGINAL request replayed
 → if refresh also fails → user is signed out
```

### Create ticket (web)
```
CreateTicket.tsx → POST /api/tickets
 → requireRole('CUSTOMER','ADMIN') → validate(createTicketSchema)
 → INSERT tickets (status NEW, reference SD-nnnn from sequence, channel WEB)
 → recordEvent('CREATED')
 → 201 RETURNED IMMEDIATELY
 → THEN void classifyAndStore(id)   ◀── not awaited
      → SELECT active categories
      → classifyTicket() → provider or fallback
      → UPDATE sentiment, ai_summary, ai_confidence,
               category_id = COALESCE(category_id, $matched)   ◀── never overwrites customer's choice
               priority only if status still NEW
      → INSERT ai_suggestions (used_fallback recorded)
SAVED: tickets, ticket_events, audit_logs, later ai_suggestions
```

### Incoming WhatsApp
```
Twilio → POST /api/whatsapp/webhook
 → verifySignature(rawBody, headers)   ◀── 403 if invalid
 → parseWebhook → normalised {providerMessageId, from, body}
 → INSERT whatsapp_messages ON CONFLICT (provider_message_id) DO NOTHING
      ◀── returns no row on a replay → processing STOPS. This is the idempotency gate.
 → findOrCreateCustomer(number)  (unusable password until they set one)
 → keyword? HELP / STATUS / CLOSE / NEW <description>
 → open ticket exists? → append message, WAITING_FOR_CUSTOMER → IN_PROGRESS
 → else → create ticket (channel WHATSAPP) + classify in background
 → reply via templates (plain text) → sendMessage()
 → ALWAYS return 200
```

### Agent reply → WhatsApp
```
TicketDetail.tsx → POST /api/tickets/:id/messages { body, aiAssisted }
 → getTicketForUser()  ◀── ownership check
 → 422 if ticket CLOSED
 → INSERT ticket_messages (channel WEB)
 → if staff && !internal: first_response_at, status → IN_PROGRESS, notify customer
 → if aiAssisted: UPDATE ai_suggestions SET was_accepted = TRUE (latest DRAFT_REPLY)
 → notifyTicketCustomer(): only if ticket.channel = 'WHATSAPP'
      → templates.agentReply() converts Markdown → WhatsApp plain text
      → sendMessage() → recorded in whatsapp_messages
```

### RAG grounded answer
```
AI panel → POST /api/ai/tickets/:id/grounded-answer
 → requireRole('AGENT','ADMIN') → buildContext()
 → query = subject + description
 → retrieve(query, 4):
      chunks embedded? no  → PostgreSQL full-text fallback
                       yes → embed(query) → cosine `<=>` over HNSW index
                             WHERE a.is_published = TRUE
 → recordRetrieval() into kb_retrievals
 → answerFromKnowledge(ctx, passages):
      passages wrapped in <passage id=...> and declared DATA not instructions
      neutralise() strips < > from content so a passage cannot escape its block
      citedIds ∩ supplied ids   ◀── invented citations discarded
 → response: answer, insufficient, sources (only cited), retrieval metadata
```

### Unauthorized request
```
Customer requests another customer's ticket
 → requireAuth OK (valid token)
 → requireRole OK (route allows any authenticated user)
 → getTicketForUser(): ticket.customer_id !== user.id
 → throws ApiError.notFound  ◀── 404, NOT 403, so ids cannot be probed
```

---

## 20E. "When I click this button, what happens?"

----------------------------------------
**SUBMIT TICKET** (customer)
----------------------------------------
**USER:** Fills subject + description, clicks "Submit ticket"
**FRONTEND:** `frontend/src/pages/customer/CreateTicket.tsx` → `mutation.mutate()`
**REQUEST:** `POST /api/tickets`
**AUTH:** Bearer access token
**MIDDLEWARE:** httpLogger → helmet → cors → rateLimit → requireAuth → requireRole('CUSTOMER','ADMIN') → validate(createTicketSchema)
**BACKEND:** `tickets.routes.ts` POST `/`
**SERVICE:** `recordEvent()`, then `void classifyAndStore()`
**DATABASE:** INSERT tickets; INSERT ticket_events; INSERT audit_logs; later UPDATE tickets + INSERT ai_suggestions
**AI:** `classifyTicket()` — after the response, never awaited
**RESPONSE:** 201 with the ticket
**FRONTEND UPDATE:** invalidates `['tickets']`, `['dashboard']`, navigates to `/tickets/:id`
**WHAT WAS SAVED:** ticket, timeline event, audit row, and (moments later) classification
**VISIBLE RESULT:** Ticket page with reference `SD-nnnn`; badges appear on reload

----------------------------------------
**GENERATE DRAFT** (agent, AI panel)
----------------------------------------
**USER:** Clicks "Generate" under Draft reply
**FRONTEND:** `frontend/src/components/AiPanel.tsx` → `draftMutation`
**REQUEST:** `POST /api/ai/tickets/:id/draft-reply`
**MIDDLEWARE:** requireAuth → requireRole('AGENT','ADMIN')
**BACKEND:** `ai.routes.ts`
**SERVICE:** `buildContext()` (public messages only) → `draftReply()`
**DATABASE:** INSERT ai_suggestions (kind DRAFT_REPLY, used_fallback)
**AI:** provider or fallback
**RESPONSE:** `{ draft, model, usedFallback, notice }`
**FRONTEND UPDATE:** editable textarea + "Review and edit" notice
**WHAT WAS SAVED:** the suggestion — **zero customer-visible messages**
**VISIBLE RESULT:** Draft in the panel, not in the reply box

----------------------------------------
**INSERT INTO REPLY → SEND**
----------------------------------------
**USER:** "Insert into reply", edits, "Send reply"
**FRONTEND:** `AiPanel.onUseDraft` → `TicketDetail.useDraft()` sets `aiAssisted=true` → `sendReply`
**REQUEST:** `POST /api/tickets/:id/messages`
**BACKEND:** `tickets.routes.ts`
**DATABASE:** INSERT ticket_messages (ai_assisted TRUE); UPDATE tickets (first_response_at, status); UPDATE ai_suggestions SET was_accepted; INSERT notifications; INSERT whatsapp_messages if the channel is WhatsApp
**RESPONSE:** 201
**VISIBLE RESULT:** Message in thread tagged "AI-assisted"; customer receives plain text on WhatsApp

----------------------------------------
**ANSWER FROM KNOWLEDGE BASE**
----------------------------------------
**USER:** Clicks grounded answer
**REQUEST:** `POST /api/ai/tickets/:id/grounded-answer`
**SERVICE:** `retrieve()` → `answerFromKnowledge()`
**DATABASE:** SELECT over kb_chunks (HNSW cosine); INSERT kb_retrievals; INSERT ai_suggestions
**RESPONSE:** answer + only-cited sources + retrieval metadata
**WHAT WAS SAVED:** retrieval record + suggestion
**VISIBLE RESULT:** Answer with citations the agent can open and verify

----------------------------------------
**DEACTIVATE USER** (admin)
----------------------------------------
**USER:** Clicks "Deactivate"
**FRONTEND:** `pages/admin/UserManagement.tsx` → `changeStatus`
**REQUEST:** `PATCH /api/users/:id/status { isActive: false }`
**MIDDLEWARE:** requireAuth → requireRole('ADMIN') → validate
**BACKEND:** 422 if the admin targets themselves (lock-out guard)
**DATABASE:** UPDATE users SET is_active = FALSE; INSERT audit_logs
**VISIBLE RESULT:** Badge flips. **That user's next request returns 403 immediately**, because `requireAuth` re-reads the row rather than trusting the token.

---

## 20F. Database deep dive

**12 tables.** Migrations: `001_init` · `002_whatsapp` · `003_knowledge_base` · `004_hnsw_index`.

| Table | Purpose | Notable |
|---|---|---|
| `users` | All three roles | `email` CITEXT unique; `whatsapp_number` unique + E.164 CHECK |
| `categories` | Ticket grouping | Also the closed vocabulary the classifier may propose |
| `tickets` | Core entity | **Two FKs to users**; all AI columns nullable |
| `ticket_messages` | Conversation | `is_internal_note` filtered **in SQL**; `ai_assisted` |
| `ticket_events` | Append-only timeline | `actor_id` SET NULL — event outlives the user |
| `ai_suggestions` | Every AI output | `used_fallback`, `was_accepted` |
| `notifications` | In-app | Composite index `(user_id, is_read, created_at DESC)` |
| `audit_logs` | Privileged actions | `metadata` JSONB |
| `whatsapp_messages` | In/out log | **`provider_message_id` UNIQUE = the idempotency mechanism** |
| `kb_articles` | Source of truth | `is_published` excludes drafts from retrieval |
| `kb_chunks` | Retrieval unit | `VECTOR(384)`, HNSW cosine index |
| `kb_retrievals` | What was retrieved | For citations and evaluation |

### Constraints that carry business rules

| Constraint | Enforces |
|---|---|
| `tickets_resolved_at_consistent` | `resolved_at` only when RESOLVED/CLOSED — **this is why reopening clears it** |
| `tickets_closed_at_consistent` | `closed_at` only when CLOSED |
| `tickets_ai_confidence_range` | Confidence in [0,1] |
| `users_whatsapp_number_e164` | Stored format matches what webhooks send |
| `kb_chunks_unique_position` | `(article_id, chunk_index)` — re-indexing is deterministic |

### Delete rules, and why each differs

| Relationship | Rule | Reason |
|---|---|---|
| customer → tickets | **RESTRICT** | Deleting would destroy support history; admins deactivate |
| agent → tickets | **SET NULL** | Tickets return to the unassigned queue |
| ticket → messages/events/chunks | **CASCADE** | Meaningless without their parent |
| actor → audit_logs | **SET NULL** | The record must outlive the account |

### Indexes

Every filter column (customer, agent, category, status, priority, sentiment,
channel), `created_at DESC` for ordering, **GIN** on `to_tsvector(subject ||
description)` for keyword search, **HNSW** `vector_cosine_ops` on
`kb_chunks.embedding`, composite `(ticket_id, created_at)` for threads and
`(user_id, is_read, created_at DESC)` for the unread badge.

### Transactions — where and why

`withTransaction()` wraps **status change** and **assignment**: each writes a
ticket row *and* a timeline event, and a status change with no event would leave
the audit trail lying about history. `recordEvent()` accepts an optional
`PoolClient` so it can join the caller's transaction.

---

## 20G. Authentication and authorization

```
login → bcrypt.compare (cost 12, auto-salted)
      → access token  (15 min, JWT, held in a JS variable — NEVER localStorage)
      → refresh token (7 d, httpOnly cookie, Secure, SameSite, path=/api/auth)
      ↓
protected request → requireAuth: verify signature
                              → RE-READ the user row  ◀── deactivation is instant
                  → requireRole: may this ROLE call this endpoint?
                  → handler:     does this RECORD belong to this caller?
```

| Concept | Implementation | Why |
|---|---|---|
| bcrypt cost 12 | ~250 ms/hash | Expensive offline, responsive online |
| Token in memory | Never persisted | An injected script cannot read a long-lived credential |
| httpOnly cookie | JS cannot read it at all | Refresh token is the valuable one |
| Path-scoped cookie | `/api/auth` only | Not attached to ordinary data requests |
| **404 not 403** | Another customer's ticket | 403 would confirm existence → enumeration |
| Identical login error | Unknown email = wrong password | Prevents account enumeration; hash still runs |
| CORS allow-list | Exact origin | Wildcards are rejected on credentialed requests |
| Rate limiting | 20 auth / 15 min, 200 / min global | Only endpoints callable without credentials |

**Known limitation — refresh token revocation.** There is **no denylist**. A
stolen refresh token stays valid for up to 7 days; signing out clears the cookie
client-side only. Mitigations: deactivating the account blocks access
immediately (the row is re-read every request). Proper fix would be rotation with
a stored token id. **State this honestly if asked.**

---

## 20H. AI deep dive

### Provider abstraction

```
routes → services/ai/index.ts  attempt(operation, primary, degraded)
              ├── AnthropicAiProvider   (HTTPS + AbortController timeout)
              └── FallbackAiProvider    (keyword rules, offline)  ◀── DEFAULT
```

`attempt()` runs the primary and converges **every** failure — timeout, 5xx, rate
limit, malformed JSON — on the fallback, returning `{result, usedFallback, model}`.
That flag reaches the database and the UI.

### Output validation

The model's output goes into **typed enum columns**, so nothing is trusted:
category must match a configured one, priority/sentiment must be valid enum
members or a safe default substitutes, confidence is clamped to [0,1].

### RAG pipeline

```
article → chunkArticle()      paragraph → sentence, ~700 chars, 100 overlap
                              title prefixed to EVERY chunk
        → embed()             384-dim, provider or deterministic
        → kb_chunks           VECTOR(384) + HNSW cosine index
                              ↓
ticket  → retrieve()          embed(query) → `<=>` cosine, is_published only
                              no embeddings? → PostgreSQL full-text fallback
        → answerFromKnowledge passages as DATA, delimiters neutralised
        → citedIds ∩ supplied invented citations discarded
        → answer + sources
```

### Prompt injection defence

1. Passages wrapped in `<passage id=...>` and the system prompt declares them
   **untrusted data, never instructions**.
2. `neutralise()` strips `<` and `>` from passage content, so a passage cannot
   close its own block and escape into the instruction space.
3. Citations are intersected with supplied ids.
4. Measured: `npm run eval` includes an injection case and reports whether the
   injected instruction was obeyed.

### Failure behaviour

| Failure | Result |
|---|---|
| Provider unavailable / no key | Fallback at boot, warned once |
| Timeout | AbortController fires → fallback |
| Malformed JSON | Parse throws → fallback |
| Rate limit | Non-2xx → fallback |
| Embeddings fail | Deterministic vectors |
| No chunks embedded | PostgreSQL full-text search |
| No relevant results | `insufficient: true`, no invented answer |
| Classification throws | Caught and logged; **ticket unaffected** |

---

## 20I. WhatsApp deep dive

```
Twilio → POST /api/whatsapp/webhook
  verifySignature()  HMAC-SHA1 over URL + sorted params, timingSafeEqual
                     403 on mismatch
  parseWebhook()     provider-specific → normalised shape
  INSERT whatsapp_messages ... ON CONFLICT (provider_message_id) DO NOTHING
                     ◀── no row returned = replay = STOP
  findOrCreateCustomer()  number is the identity; unusable password
  keyword or content routing
  reply via templates/*  ← plain text only
  ALWAYS 200
```

**Why always 200:** providers retry non-2xx. A message that cannot be processed
fails identically every retry, so an error response creates an infinite loop.

**Plain text:** WhatsApp renders no Markdown. `services/whatsapp/format.ts`
converts `**bold**`→`*bold*`, headings→bold lines, strips code ticks, normalises
lists, keeps link text + URL, and truncates at 4096 on a word boundary
(the suffix length is subtracted from the budget — an earlier version emitted
4097 and would have been rejected).

---

## 20J. Testing

**153 tests, 6 files, real PostgreSQL with production migrations.** Providers
forced offline so results are deterministic. Single-threaded — they share one
database.

| File | Tests | Covers | Breaks if… |
|---|---|---|---|
| `auth.test.ts` | 13 | Registration, login, hashing, tokens, deactivation | Passwords stored plain, or enumeration becomes possible |
| `authorization.test.ts` | 26 | **Every role boundary, called directly against the API** | Any authz check is removed |
| `tickets.test.ts` | 33 | CRUD, assignment, lifecycle, messages, search | A transition guard is dropped |
| `ai.test.ts` | 20 | Lifecycle rules, fallback classifier, AI failure | Classification failure starts breaking ticket creation |
| `whatsapp.test.ts` | 35 | Formatting, inbound, two-way, idempotency | Duplicate webhooks start creating duplicate tickets |
| `knowledge.test.ts` | 26 | Embeddings, chunking, retrieval, RAG, authz | Retrieval silently returns nothing (it did — see §20N) |

---

## 20K. Docker

`docker compose up --build` →

1. **postgres** (`pgvector/pgvector:pg16`) starts, `pg_isready` healthcheck
2. **migrate** waits for `service_healthy`, applies 4 migrations + seed, **exits 0**
3. **api** waits for `service_completed_successfully`, starts on :4000, curl healthcheck
4. **frontend** nginx serves the built SPA on :8080

Separating migrate means the schema applies **exactly once** regardless of API
replicas, and a migration failure is its own visible failure.

| Task | Command |
|---|---|
| Start | `docker compose up -d --build` |
| Stop | `docker compose down` |
| Stop + wipe data | `docker compose down -v` |
| Logs | `docker compose logs -f api` |
| Rebuild one | `docker compose build api && docker compose up -d api` |
| Re-run migrations | `docker compose run --rm migrate` |
| psql | `docker compose exec postgres psql -U servicedesk -d servicedesk` |
| Tests (needs postgres up) | `cd backend && npm test` |

**Note:** migrations are copied into the image at build time, so a **new
migration requires a rebuild**.

---

## 20L. Cloud deployment

**STATUS: NOT DEPLOYED — EXTERNALLY BLOCKED.**

Verified on this machine: no `vercel`, `render`, `flyctl`, `supabase`, `aws`,
`gcloud` or `az` CLI, and no stored cloud credentials. Deployment requires
accounts that cannot be created without your authorisation.

**No live URL exists and none is claimed anywhere in this repository.**

What **is** ready:

| Artefact | Purpose |
|---|---|
| `render.yaml` | Render Blueprint — provisions PostgreSQL 16 + API together, generates JWT secrets, runs `npm run migrate` before `npm start` (free tier has no `preDeployCommand`), health check at `/api/health` |
| `frontend/vercel.json` | SPA rewrite so deep links resolve |
| `docs/DEPLOYMENT.md` | Step-by-step with an 11-point verification checklist |
| Docker images | Both build and run, proven locally |

**To deploy:** Render dashboard → New → Blueprint → select the repo → supply
`CORS_ORIGIN` after the frontend URL exists. Then Vercel → import → root
`frontend` → set `VITE_API_BASE_URL`.

---

## 20M. CI/CD

```
git push → GitHub Actions (.github/workflows/ci.yml)
  ├─ backend:  npm ci → typecheck → build → migrate → test → eval (informational)
  │            services: pgvector/pgvector:pg16 with a pg_isready healthcheck
  ├─ frontend: npm ci → typecheck → build
  └─ docker:   build both images with GHA layer cache
```

Same Postgres image as Compose, so CI cannot pass on a database that differs
from local. Offline AI/embedding providers keep runs hermetic and deterministic.
No secrets required.

---

## 20N. Failure scenarios

| Scenario | Failure | Detection | System response | User experience |
|---|---|---|---|---|
| Wrong password | Auth | bcrypt.compare | 401, identical to unknown email | "Invalid email or password." |
| Expired JWT | Auth | jwt.verify | 401 | Silent refresh + replay |
| Invalid refresh | Auth | jwt.verify | 401 | Signed out |
| Wrong role | Authz | requireRole | 403 | "This action requires…" |
| Another's ticket | Authz | ownership check | **404** | "Ticket not found" |
| Invalid body | Validation | Zod | 400 + field errors | Inline messages |
| Invalid transition | Business rule | `canTransition` | 422 | Names allowed transitions |
| Duplicate webhook | Integration | UNIQUE violation | Dropped | Nothing — no duplicate |
| Twilio send fails | Integration | non-2xx | Recorded FAILED, **admins notified** | Reply still saved in web app |
| AI timeout | External | AbortController | Fallback | Slightly weaker suggestion |
| AI unavailable | External | boot check | Fallback | Panel says fallback was used |
| Malformed AI JSON | External | parse throws | Fallback | Transparent |
| Classification throws | Internal | try/catch | Logged, dropped | **Ticket unaffected** |
| Embeddings fail | External | catch | Lexical vectors | Weaker ranking |
| **Empty vector index** | **Retrieval** | **Silent — returned fewer rows** | **FIXED: HNSW** | **Was: less grounded answers, no error** |
| No relevant results | Retrieval | empty set | `insufficient: true` | "Not covered — an agent will review" |
| DB unavailable | Infra | pool error | `/api/health` 503 | Generic error, no stack trace |
| Backend unreachable | Infra | fetch rejects | Client error | "Cannot reach the server" + retry |

### The most instructive failure

Migration 003 created an **IVFFlat** index on an **empty** `kb_chunks` table.
IVFFlat trains centroids from data present at build time; with none, index scans
returned almost nothing. A query for 3 nearest neighbours over 5 chunks returned
**1 row** — proven by disabling index scans and getting 4.

It failed **silently**: retrieval returned fewer results, never an error, so RAG
answers were quietly less grounded. Fixed by migration 004 → **HNSW**, which
builds incrementally and needs no training pass.

---

## 20O. Live demo (5–10 min)

**Before:** `docker compose up -d --build`, wait for healthy, have three browser
profiles signed in as customer/agent/admin, and `/api/docs` open in a tab.

1. **(30 s)** `docker compose ps` — four services, healthy. *"One command, whole stack."*
2. **(60 s)** Customer raises a ticket with obvious signal ("payment deducted… urgent").
3. **(30 s)** Reload → classified Billing / Urgent / Negative. *"That ran after the DB commit and was never awaited."*
4. **(30 s)** Edit URL to another customer's ticket → **404**. *"Not 403 — ids can't be probed."*
5. **(45 s)** Agent queue: filters, full-text search.
6. **(90 s)** **RAG.** Grounded answer → citations. Open the cited article. *"Answers only from our documented material; invented citations are discarded."*
7. **(45 s)** Draft reply → insert → **edit visibly** → send. *"No AI text reaches a customer without a human."*
8. **(30 s)** WhatsApp console → simulate inbound → ticket appears. Send it **twice** → still one ticket.
9. **(45 s)** `/api/docs` — Swagger, generated from the validation schemas.
10. **(45 s)** `npm run eval` — real measured numbers.
11. **(30 s)** CI green on GitHub.

**Do NOT waste time on:** the landing page, profile editing, category CRUD,
pagination, the notification bell, or walking through the React component tree.

---

## 20P. Top 15 engineering talking points

1. **Two-layer authorization** — role on route, ownership in handler. Middleware cannot know if ticket X belongs to customer Y. *Alternative: single middleware — cannot express record-level rules.*
2. **404 not 403** — prevents enumeration. *Alternative: 403, which confirms existence.*
3. **Business invariants as CHECK constraints** — holds even when app code is wrong; caught a real reopen bug. *Alternative: app-only validation, which every future code path must remember.*
4. **Webhook idempotency via UNIQUE** — race-free by construction. *Alternative: SELECT-then-INSERT, which has a race window.*
5. **Always 200 on webhooks** — non-2xx triggers infinite provider retries.
6. **HMAC signature verification** — the webhook is public by necessity; signature is the only authentication available.
7. **Graceful degradation as architecture** — one `attempt()` funnel, not scattered try/catch. Flag persisted so statistics stay honest.
8. **Classification off the critical path** — after commit, never awaited. Decided *before* writing the feature; retrofitting is much harder.
9. **HNSW over IVFFlat** — IVFFlat on an empty table silently returns fewer rows. Strongest debugging story you have.
10. **pgvector over a dedicated vector DB** — corpus is small and already relational; one datastore, one backup, one pool.
11. **Prompt injection defence** — passages as delimited data, delimiters neutralised, citations intersected with supplied ids.
12. **Transactions where writes must agree** — status + event together, via an optional `PoolClient`.
13. **Real-database tests** — a mock would accept rows a CHECK constraint rejects.
14. **OpenAPI generated from Zod** — the validating schema *is* the documented schema, so they cannot drift.
15. **Structured logging with redaction at the logger** — tokens and cookies cannot leak through a future careless call site.

---

## 20Q. Thirty interview questions

**Backend & REST**
1. Why a modular monolith rather than microservices? *(Testing: judgment over fashion.)* — One deployable, one database, no network partition between modules; the team is two people.
2. Why 422 for an invalid transition rather than 400? — 400 means malformed; the request was well-formed and broke a business rule.
3. How do you prevent a fat controller? — Queries and scoping in `*.service.ts`; routes own HTTP and side effects.
4. Why does `recordEvent` take an optional client? — So it can join a caller's transaction instead of opening its own.
5. What happens on SIGTERM? — `server.close()`, drain, `closePool()`, 10 s hard-exit backstop.

**Database**
6. Why two FKs to `users` on `tickets`? — customer and assigned agent; every query joins `users` twice.
7. Why different delete rules? *(Testing: did you think, or accept defaults.)*
8. Why enums not lookup tables? — Fixed by spec; declaration order gives correct priority sorting free.
9. What does the GIN index do? — Full-text over subject+description for `?q=`.
10. Why is `first_response_at` stored when it is derivable? — Deliberate denormalisation; three dashboards would otherwise aggregate per request.
11. Why UUIDs not serial ids? — Sequential ids leak volume and are enumerable.

**Security**
12. Why bcrypt cost 12? — ~250 ms: expensive offline, responsive online.
13. Why is the access token in memory? — Not readable by an injected script; the refresh token in an httpOnly cookie is the durable one.
14. **Can you revoke a refresh token?** — **No. Honest answer: no denylist; up to 7 days. Deactivation blocks access immediately because the row is re-read per request.**
15. How is SQL injection prevented? — Parameterised throughout; the only dynamic SQL fragment is a sort column from a fixed allow-list.
16. Why can't CORS be a wildcard? — Credentials are sent; browsers reject `*` on credentialed requests.
17. Prove RBAC isn't UI-only. — 26 tests calling the API directly with wrong-role tokens.

**AI & RAG**
18. Is a keyword classifier AI? *(Testing: honesty.)* — No. It is a deterministic baseline that guarantees availability; the LLM path is the AI, and `used_fallback` records which ran.
19. Why chunk at all? — A long article drowns the one relevant paragraph and wastes context.
20. Why prefix the title to every chunk? — A passage that never repeats the subject is otherwise unretrievable.
21. Why cosine, not Euclidean? — Vectors are L2-normalised; direction is the signal, magnitude is passage length.
22. How do you stop the model inventing a citation? — Intersect returned ids with supplied ids.
23. How do you handle prompt injection from KB content? — Delimited passages declared as data, delimiters stripped, plus the eval's injection case.
24. What is your retrieval accuracy? — hit@1 46.2%, hit@3 61.5% with the **lexical** offline embedder against a 33.3% random baseline; `npm run eval` reproduces it.
25. Why pgvector and not Pinecone? — Small corpus, already relational, one datastore to deploy and back up.

**Cloud, Docker, CI, testing**
26. Why is migrate a separate compose service? — Schema applies once regardless of replicas; failure is visible as its own failure.
27. Why non-root in the container? — A compromised process should not be root.
28. Why the same Postgres image in CI and Compose? — CI cannot pass on a database that differs from local; and `postgres:16` lacks pgvector.
29. Why tests against a real database? — A mock accepts rows a CHECK constraint rejects.
30. What would you do next? — Refresh-token rotation, semantic embeddings + re-measure, frontend tests, retry/DLQ for background classification.

---

## 20R. How to modify the project

| Task | Where | Steps |
|---|---|---|
| Add an endpoint | `modules/<area>/*.routes.ts` | Zod schema → route with `requireRole` → handler → test → register in `openapi/spec.ts` |
| Add a table | `src/db/migrations/00N_*.sql` | New numbered file → `npm run migrate` → **rebuild the image** |
| Change ticket schema | migration + `tickets.service.ts` `TICKET_SELECT`/`toTicketDto` + `frontend/src/lib/types.ts` | |
| Add a lifecycle state | `lifecycle.ts` `TRANSITIONS` + enum migration + `format.ts` badge colour | |
| Change AI behaviour | `services/ai/anthropic.provider.ts` prompts | Re-run `npm run eval` to see the effect |
| Add an AI provider | Implement `AiProvider`, add to `selectProvider()` | Nothing else changes |
| Add a messaging provider | Implement `WhatsAppProvider`, add to `selectProvider()` | |
| Tune RAG | `knowledge.service.ts`: `TARGET_CHUNK_CHARS`, `CHUNK_OVERLAP_CHARS`, `retrieve(..., limit)` | Re-index and re-run eval |
| Switch to real embeddings | `EMBEDDING_PROVIDER=openai` + key | **Re-index every article** — vectors from different models are not comparable |
| Add a frontend screen | `pages/` + route in `App.tsx` + nav in `AppShell.tsx` | |

---

## 20S. Final cheat sheet

**30 seconds:** Multi-channel support platform. WhatsApp + web tickets, LLM-assisted triage that degrades to a deterministic classifier, RAG answers with citations over pgvector. TypeScript, PostgreSQL, Docker, CI.

**2 minutes:** See §20A.

**Architecture in 10 lines**
1. React SPA (nginx) → 2. Stateless Express REST API → 3. PostgreSQL 16 + pgvector
4. JWT access token in memory + httpOnly refresh cookie
5. Two-layer authz: role on route, ownership on record
6. Six-state ticket lifecycle from one transition table
7. WhatsApp inbound: HMAC-verified, idempotent on provider message id
8. AI adapter: Anthropic or deterministic fallback, failures converge
9. RAG: chunk → embed → HNSW cosine → grounded answer + citations
10. Docker Compose, GitHub Actions, OpenAPI from Zod

**Technologies:** TypeScript · Node 20 · Express · PostgreSQL 16 · pgvector · Zod · pino · JWT · bcrypt · React 18 · Vite · Tailwind · TanStack Query · Recharts · Docker · nginx · GitHub Actions · Vitest · Supertest · OpenAPI

**Commands**
```bash
docker compose up -d --build          # whole stack
docker compose down -v                # stop + wipe
cd backend && npm test                # 153 tests
cd backend && npm run eval            # AI metrics
cd backend && npm run migrate         # migrations
docker compose logs -f api            # logs
```

**URLs (local):** app `http://localhost:8080` · API `http://localhost:4000/api` · docs `http://localhost:4000/api/docs` · spec `/api/openapi.json` · health `/api/health`

**Live URL:** none — not deployed.

**Demo accounts:** `admin@servicedesk.ai` / `Admin@12345` · `priya.agent@servicedesk.ai` / `Agent@12345` · `rohan@example.com` / `Customer@12345`

**Files you must know:** `lifecycle.ts` · `tickets.service.ts` (`buildFilters`) · `services/ai/index.ts` (`attempt`) · `knowledge.service.ts` · `whatsapp.service.ts` (`handleInbound`) · `middleware/auth.ts` · `migrations/004_hnsw_index.sql`
