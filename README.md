# ServiceDesk AI

**A cloud-native customer support SaaS platform for small businesses.**

Receive customer complaints, turn them into trackable support tickets, route them to the right agent, and give that agent AI assistance — classification, summaries and draft replies — so small teams can respond like large ones.

Built for **BCSE408L – Cloud Computing**, School of Computer Science Engineering and Information Systems, VIT Chennai (AY 2026–2027).

| | |
|---|---|
| **Project** | Project 19 — ServiceDesk AI |
| **SaaS Category** | Customer Support SaaS |
| **Problem Statement** | Manage customer complaints and automate ticket handling |
| **Target Users** | Customer · Support Agent · Admin |
| **Live URL** | _Not yet deployed — will be published at R2 (17 September)_ |

---

## Team

| Name | Registration No. |
|---|---|
| Aarush Jagannathan | 23BLC1211 |
| Gomatheswar M | 23BLC1195 |

---

## Project Status

This repository is under active development across three review milestones. The table below reflects what is **actually built and verified**, not what is planned.

| Milestone | Date | Focus | Status |
|---|---|---|---|
| **R1** | 20 August | Requirements, SRS, use cases, UI mockups | In progress |
| **R2** | 17 September | Architecture, database, REST APIs, auth, core modules, initial deployment | Not started |
| **R3 / Final Demo** | 15 October | Complete application, testing, reports, live URL, documentation | Not started |

**Nothing in this README should be read as a claim that a feature is deployed.** Feature descriptions below describe the designed system; the status table above is the source of truth for what exists.

---

## The Problem

A small business receiving customer complaints over email, WhatsApp and phone has no reliable way to know what was reported, who is handling it, or whether it was ever resolved. Requests are lost in inboxes, the same issue is answered twice by different people, and there is no record of how long anything took.

Dedicated helpdesk products solve this, but they are priced per agent per month and assume a support team large enough to justify the cost. A three-person business is left with a shared inbox and a spreadsheet.

## The Solution

ServiceDesk AI gives a small business a single cloud-hosted place where every complaint becomes a ticket with an owner, a priority, a category and a status. Customers see exactly where their request stands. Agents see one prioritised queue instead of an inbox. Admins see what is actually happening across the business.

The AI layer exists because small teams do not have a triage person. When a ticket arrives, the system proposes a category, a priority, a sentiment reading and a one-line summary, and can draft a reply for the agent to review and edit. **The agent always approves before anything reaches a customer** — the AI assists, it does not decide.

---

## Features

### Customer
- Register, log in, and manage a profile
- Raise a support ticket with subject, description and optional attachment
- View, search and filter their own tickets
- Follow the full conversation thread on any ticket
- Reply to an agent and reopen a resolved ticket
- Receive in-app notifications on assignment, reply and resolution

### Support Agent
- Prioritised ticket queue with filters for status, priority, category, date and sentiment
- Full-text search across ticket reference, subject, customer and keywords
- Update status, priority, category and assignment, with the lifecycle enforced server-side
- Public replies to customers and internal notes visible only to staff
- **AI Assistance Panel** — summary, suggested resolution steps, and an editable draft reply
- Personal metrics: assigned, open, high-priority, resolved, average resolution time

### Admin
- Manage users, agents, roles and account deactivation
- Manage ticket categories
- Global dashboard: tickets by status, priority and category; agent workload; sentiment distribution; volume trends
- Reports with CSV export
- Activity and audit log of every privileged action

### AI Assistance
| Capability | What it does | Human control |
|---|---|---|
| Ticket classification | Suggests category, priority and sentiment on submission | Agent can override any field |
| Ticket summarisation | One-line summary of a long conversation | Advisory only |
| Draft reply | Generates a response for the agent | Agent must review and edit before sending |
| Resolution steps | Suggests troubleshooting steps | Advisory only |
| Dashboard insights | Sentiment and category patterns from real ticket data | Read-only analytics |

> **Design note.** AI is a value-add, not a course requirement — the official Project 19 specification does not mention AI. The system is therefore built so that **no mandatory feature depends on it**. If the AI provider is unreachable, the service falls back to a deterministic rule-based classifier and every core workflow — ticket creation, CRUD, dashboards, reports — continues to work unchanged.

---

## Architecture

Three independently deployed and independently scalable tiers.

```
┌──────────────────────────────────────────────────────────┐
│  Browser — desktop / tablet / mobile                       │
│  React + Vite SPA, served from the Vercel CDN              │
└────────────────────┬─────────────────────────────────────┘
                     │  HTTPS · JSON · Bearer JWT
                     ▼
┌──────────────────────────────────────────────────────────┐
│  REST API — Node.js + Express (Render Web Service)         │
│    middleware   cors · helmet · rate-limit · auth · rbac   │
│    modules      authentication · user-management ·         │
│                 tickets · reports · administration         │
│    services/ai  provider adapter ──────► AI API (HTTPS)    │
└────────────────────┬─────────────────────────────────────┘
                     │  TLS · pooled connections
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Supabase — managed PostgreSQL + object storage            │
└──────────────────────────────────────────────────────────┘
```

**Why this is cloud-native.** No component runs on a machine we own or manage. The frontend is static content on a global CDN, the API is a stateless container that the platform can run in multiple replicas, and the database is a managed service with its own backups and availability guarantees. State lives only in Postgres, which is what makes the API horizontally scalable. Authentication is stateless JWT for the same reason. The application is multi-tenant by role, and the deployment is reachable from any browser on the public internet.

The AI provider is called **only from the backend**. The API key never reaches the browser.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query, Recharts |
| Backend | Node.js 20, Express, TypeScript, Zod |
| Database | PostgreSQL (Supabase managed) |
| Authentication | JWT access token + refresh token, bcrypt password hashing |
| AI | Backend-only provider adapter with deterministic rule-based fallback |
| Frontend hosting | Vercel |
| Backend hosting | Render |
| Database & storage hosting | Supabase |
| Testing | Vitest, Supertest |

---

## User Roles and Access Control

| Capability | Customer | Agent | Admin |
|---|:---:|:---:|:---:|
| Register and manage own profile | ✓ | ✓ | ✓ |
| Create a ticket | ✓ | — | ✓ |
| View own tickets | ✓ | ✓ | ✓ |
| View all tickets | — | ✓ | ✓ |
| Reply to a ticket | ✓ | ✓ | ✓ |
| Add an internal note | — | ✓ | ✓ |
| Change status, priority, category | — | ✓ | ✓ |
| Assign or escalate a ticket | — | ✓ | ✓ |
| Use the AI assistance panel | — | ✓ | ✓ |
| Delete a ticket | — | — | ✓ |
| Manage users, agents and roles | — | — | ✓ |
| Manage categories | — | — | ✓ |
| View global dashboard and reports | — | — | ✓ |
| View audit log | — | — | ✓ |

Access control is enforced **in the API**, not by hiding buttons. Every protected route passes through role middleware, and every ticket handler additionally verifies record ownership — a customer requesting another customer's ticket receives `403`, regardless of what the UI shows.

---

## Ticket Lifecycle

```
NEW ──► OPEN ──► IN_PROGRESS ──► RESOLVED ──► CLOSED
          │           │              ▲
          │           ▼              │
          └──► WAITING_FOR_CUSTOMER ─┘
```

Valid transitions are defined in one place on the server and validated on every status change. An invalid transition is rejected with `422`, not silently applied.

---

## Getting Started

### Prerequisites
- Node.js 20 or later
- A Supabase project (or any PostgreSQL 15+ instance)

### Setup

```bash
git clone https://github.com/ItzGOLLY/servicedesk-ai.git
cd servicedesk-ai
```

Backend:

```bash
cd backend && npm install && cp .env.example .env && npm run migrate && npm run seed && npm run dev
```

Frontend, in a second terminal:

```bash
cd frontend && npm install && cp .env.example .env && npm run dev
```

### Environment Variables

Copy `.env.example` and fill in real values. **Never commit `.env`.**

| Variable | Location | Purpose |
|---|---|---|
| `DATABASE_URL` | backend | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | backend | Signs short-lived access tokens |
| `JWT_REFRESH_SECRET` | backend | Signs refresh tokens |
| `AI_PROVIDER` | backend | AI provider, or `fallback` to disable external calls |
| `AI_API_KEY` | backend | AI provider key — backend only, never exposed to the client |
| `CORS_ORIGIN` | backend | Allowed frontend origin |
| `PORT` | backend | API port |
| `VITE_API_BASE_URL` | frontend | Base URL of the REST API |

### Database Setup

Schema is managed with plain, numbered SQL migrations in `backend/src/db/migrations/`, applied in order by `npm run migrate`. The ER diagram in `docs/DATABASE_DESIGN.md` is generated from these files, so the diagram and the database cannot drift apart.

---

## API Overview

All endpoints are namespaced under `/api`. Full request and response documentation lives in [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md).

| Group | Purpose |
|---|---|
| `/api/auth` | Registration, login, token refresh, logout, current user |
| `/api/users` | Profile management and admin user administration |
| `/api/tickets` | Ticket CRUD, status transitions, assignment, search and filtering |
| `/api/tickets/:id/messages` | Ticket conversation thread |
| `/api/categories` | Category management |
| `/api/notifications` | In-app notifications |
| `/api/dashboard` | Role-specific dashboard metrics |
| `/api/reports` | Analytical reports and CSV export |
| `/api/ai` | Classification, summary, draft reply, resolution steps |
| `/api/audit-logs` | Admin activity log |

Responses follow one shape: `{ success, data, meta }` on success and `{ success: false, error: { code, message, details } }` on failure.

---

## Testing

```bash
cd backend && npm test
```

Coverage targets authentication, authorisation boundaries, ticket CRUD and lifecycle transitions, AI failure handling, and API error cases. Results are recorded in [`docs/TESTING.md`](docs/TESTING.md).

---

## Deployment

Deployment procedure, environment configuration, CORS setup, build and start commands, verification steps and troubleshooting are documented in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/SRS.md`](docs/SRS.md) | Software Requirements Specification |
| [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md) | Every course requirement mapped to its implementation, test and demo step |
| [`docs/SYSTEM_ARCHITECTURE.md`](docs/SYSTEM_ARCHITECTURE.md) | Application architecture and module design |
| [`docs/CLOUD_ARCHITECTURE.md`](docs/CLOUD_ARCHITECTURE.md) | Cloud components, data flow, auth flow, deployment flow |
| [`docs/DATABASE_DESIGN.md`](docs/DATABASE_DESIGN.md) | Entities, relationships, keys, indexes, constraints, ER diagram |
| [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md) | Endpoint reference |
| [`docs/TESTING.md`](docs/TESTING.md) | Test cases, expected and actual results |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deployment guide |
| [`docs/VIVA_PREPARATION.md`](docs/VIVA_PREPARATION.md) | Design rationale and likely evaluation questions |

Documents are added as their milestone is reached; a link above may point to a file that does not exist yet.

---

## Repository Structure

```
servicedesk-ai/
├── frontend/          React + Vite single-page application
├── backend/           Express REST API
│   └── src/
│       ├── modules/   authentication · user-management · tickets ·
│       │              reports · administration
│       ├── services/  AI provider adapter
│       ├── middleware/
│       └── db/        connection pool, migrations, queries
├── docs/              SRS, architecture, database, API, testing, deployment
├── diagrams/          Use case, ER and architecture diagrams
├── screenshots/       Application screenshots
└── README.md
```

Backend module names deliberately mirror the module names in the course project specification — Authentication, User Management, Core Business Module, Reports & Analytics, Administration.

---

## Development Practice

- One repository for the team, with regular commits throughout the semester
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- `.env` is gitignored; no secret has ever been committed
- All code is original work by the two team members named above

---

## License

Academic coursework, submitted for BCSE408L at VIT Chennai. Not licensed for reuse.
