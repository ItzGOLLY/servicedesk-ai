# Requirements Traceability Matrix

Every requirement from the three official BCSE408L documents, mapped to its implementation, test evidence and demonstration step.

**Sources** — A1: Project Guidelines · A2: Review Schedule & Report Template · A3: Project List, Project 19

**Status** — ✅ Done and verified · 🟡 Requires your preparation · ⬜ Deliberately out of scope

**Live:** app https://servicedesk-ai-two.vercel.app · API https://servicedesk-api-ss2d.onrender.com/api · deployed 19 September 2026

---

## 1. Mandatory technical requirements (A1 §3)

| ID | Requirement | Implementation | File / module | Test evidence | Demo step | Status |
|---|---|---|---|---|---|---|
| G-2 | User Registration & Login | Registration, login, refresh, logout, current user | `modules/authentication/auth.routes.ts`, `pages/Login.tsx`, `pages/Register.tsx` | A-01 – A-13 | 2 | ✅ |
| G-3 | Role-Based Access | Route role middleware plus record ownership checks | `middleware/rbac.ts`, `middleware/auth.ts`, `tickets.service.ts` | R-01 – R-26 | 6, 11 | ✅ |
| G-4 | CRUD Operations | Ticket create/read/update/delete; user and category CRUD | `modules/tickets/`, `modules/user-management/`, `modules/administration/` | T-01 – T-14 | 3, 9, 12 | ✅ |
| G-5 | Dashboard & Reports | Three role dashboards; seven reports; CSV export | `modules/reports/`, `pages/admin/AdminDashboard.tsx`, `pages/admin/Reports.tsx` | Manual (browser) | 12, 13 | ✅ |
| G-6 | Cloud Database | Managed PostgreSQL 16 + pgvector on Render, versioned SQL migrations | `db/migrations/00*.sql`, `db/pool.ts`, `render.yaml` | Whole suite runs on real PostgreSQL; live health check | 14 | ✅ |
| G-7 | REST APIs | ~40 endpoints across 9 groups, consistent envelopes | `app.ts` and all `*.routes.ts` | Whole suite via supertest | 15 | ✅ |
| G-8 | Responsive UI | Tailwind design system, responsive from 375 px | `index.css`, `AppShell.tsx`, all pages | Manual at 375 / 768 / 1280 | 10 | ✅ |
| G-9 | Live Cloud Deployment | Vercel (frontend) + Render (API + PostgreSQL) | `render.yaml`, `frontend/vercel.json`, `DEPLOY_TOMORROW.md` | Live URLs above | 1 | ✅ |
| G-10 | GitHub Repository | Public repo, meaningful commits, README, .gitignore | github.com/ItzGOLLY/servicedesk-ai | — | 16 | ✅ |

---

## 2. Process requirements (A1)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| G-1 | Team of exactly two students | Aarush Jagannathan (23BLC1211), Gomatheswar M (23BLC1195) | ✅ |
| G-11 | One repo, regular commits, meaningful README, no copied repos | Repository history; `README.md` | ✅ |
| G-12 | Public URL; localhost-only is not complete | https://servicedesk-ai-two.vercel.app | ✅ |
| G-13 | Every member can explain **or modify** any line | `VIVA_PREPARATION.md` incl. a "modify it now" rehearsal table; per-module comments | 🟡 *(requires your study, not code)* |
| G-14 | No copied code, no purchased templates | All original; design system hand-built, no UI kit | ✅ |
| G-15 | Final submission: Report, PPT, Repo, Live URL, Source, Demo | Report, PPT, repository, live URL, source, demo script all present | ✅ |

---

## 3. Official functional requirements (A3 §5)

| ID | Requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| FR-1 | User registration and login | `modules/authentication/` | A-01 – A-13 | ✅ |
| FR-2 | Profile management | `users.routes.ts` `/users/me*`, `pages/Profile.tsx` | Manual | ✅ |
| FR-3 | Role-based access control | `middleware/rbac.ts` + ownership checks | R-01 – R-26 | ✅ |
| FR-4 | CRUD operations | `modules/tickets/tickets.routes.ts` | T-01 – T-22 | ✅ |
| FR-5 | Search and filtering | `buildFilters()`, GIN full-text index | T-27 – T-33 | ✅ |
| FR-6 | Dashboard | `modules/reports/dashboard.routes.ts` | Manual (browser) | ✅ |
| FR-7 | Notifications | `services/notifications.ts`, `notifications.routes.ts` | T-13 | ✅ |
| FR-8 | Report generation | `reports.routes.ts` incl. CSV export | Manual | ✅ |
| FR-9 | Cloud database integration | `db/pool.ts`, migrations, Render PostgreSQL | Suite runs on real PostgreSQL; live | ✅ |
| FR-10 | Administrator module | `user-management/`, `administration/` | R-23 – R-26 | ✅ |

---

## 4. Official non-functional requirements (A3 §6)

| ID | Requirement | How it is met | Evidence | Status |
|---|---|---|---|---|
| NFR-1 | Security | bcrypt(12), JWT + httpOnly refresh, two-layer RBAC, Zod validation, parameterised SQL, Helmet, CORS allow-list, rate limiting | A-03, A-08, R-01 – R-26 | ✅ |
| NFR-2 | Scalability | Stateless API, bounded pool, pagination, CDN frontend | `CLOUD_ARCHITECTURE.md` §8 | ✅ |
| NFR-3 | Availability | Managed services, `/api/health`, graceful shutdown, AI degradation | AI-11, health endpoint | ✅ |
| NFR-4 | Performance | Indexes on every filter column, GIN search index, pagination, client caching, AI off the critical path | `DATABASE_DESIGN.md` §4.3 | ✅ |
| NFR-5 | Reliability | DB constraints, single lifecycle table, transactions (status change + assignment), audit log | T-16 – T-21, L-01 – L-05 | ✅ |
| NFR-6 | Usability | One design system, responsive, explicit loading/empty/error states | Manual | ✅ |

---

## 5. Cloud requirements (A3 §8)

| Requirement | Implementation | Status |
|---|---|---|
| Cloud-hosted database | Render managed PostgreSQL 16 + pgvector | ✅ |
| REST APIs | ~40 endpoints | ✅ |
| Cloud storage where applicable | **Not implemented.** Attachments were scoped out; the schema anticipates them | ⬜ *(deliberate)* |
| Public cloud deployment | Vercel + Render | ✅ |

---

## 6. Review deliverables (A2)

### R1 — 20 August

| Deliverable | Artefact | Status |
|---|---|---|
| Problem Statement | `SRS.md` §2; deck slide 2 | ✅ |
| Existing System | `SRS.md` §3; deck slide 3 | ✅ |
| Proposed System | `SRS.md` §4; deck slide 4 | ✅ |
| Functional Requirements | `SRS.md` §8; deck slide 8 | ✅ |
| Non-Functional Requirements | `SRS.md` §9; deck slide 9 | ✅ |
| Scope | `SRS.md` §6; deck slide 6 | ✅ |
| Use Case Diagram | `diagrams/use-case-diagram.md`; deck slide 10 | ✅ |
| UI Mockups | Deck slides 12–14 — **and the built application exceeds them** | ✅ |
| Initial SRS | `SRS.md` (complete, 14 sections) | ✅ |

### R2 — 17 September

| Deliverable | Artefact | Status |
|---|---|---|
| System Architecture | `SYSTEM_ARCHITECTURE.md` | ✅ |
| Cloud Architecture | `CLOUD_ARCHITECTURE.md` | ✅ |
| Database Design | `DATABASE_DESIGN.md` | ✅ |
| ER Diagram | `DATABASE_DESIGN.md` §2 (Mermaid, derived from the migration) | ✅ |
| Module Design | `SYSTEM_ARCHITECTURE.md` §1, §4 | ✅ |
| API Design | `API_DOCUMENTATION.md` | ✅ |
| Authentication | `modules/authentication/`, `middleware/auth.ts` | ✅ |
| Core Modules | All five spec modules implemented | ✅ |
| GitHub Repository | Public, with history | ✅ |
| Initial Cloud Deployment | Live on Vercel + Render | ✅ |

### R3 / Final Demo — 15 October

| Deliverable | Artefact | Status |
|---|---|---|
| Complete SaaS Application | Backend + frontend, verified running | ✅ |
| Public Live URL | https://servicedesk-ai-two.vercel.app | ✅ |
| Responsive UI | Verified at 375 / 768 / 1280 | ✅ |
| Cloud Database | Render managed PostgreSQL | ✅ |
| Testing | 161 automated tests, all passing; CI green; `TESTING.md` | ✅ |
| Final Report | `ServiceDesk_AI_Review2_Review3_Submission.docx` / `.pdf` (A2 22-section template) | ✅ |
| PPT | `ServiceDesk_AI_Final_Demo.pptx` | ✅ |
| GitHub Repository | Public, with history | ✅ |
| Working Demonstration | `DEMO_SCRIPT.md` against the live URL | ✅ |

### Final demonstration checklist (A2)

| Item | Status |
|---|---|
| Registration/Login | ✅ |
| Role-based Access | ✅ |
| Core Workflow | ✅ |
| Cloud Deployment | ✅ |
| Live URL | ✅ |
| GitHub Repository | ✅ |
| Responsive Design | ✅ |
| Q&A by both team members | 🟡 *(your preparation)* |

---

## 7. AI features — design decisions, not requirements

**The official Project 19 specification does not require AI.** Only the project title contains it. Every item below is our own addition, deliberately built so that no mandatory requirement depends on it.

| ID | Capability | Implementation | Test evidence | Status |
|---|---|---|---|---|
| AI-1 | Classification (category, priority, sentiment, summary) | `services/ai/`, `classifyAndStore()` | AI-01 – AI-05, AI-08 | ✅ |
| AI-2 | Agent-reviewed draft reply | `modules/ai/ai.routes.ts`, `components/AiPanel.tsx` | AI-06, AI-12, AI-13 | ✅ |
| AI-3 | Conversation summarisation | `POST /ai/tickets/:id/summary` | AI-14 | ✅ |
| AI-4 | Suggested resolution steps | `POST /ai/tickets/:id/resolution-steps` | AI-07 | ✅ |
| AI-5 | AI never messages a customer directly | Draft returned only; agent must post the message | AI-12 | ✅ |
| AI-6 | Graceful degradation to a rule-based classifier | `fallback.provider.ts`, `attempt()` | AI-09, AI-11, AI-15 | ✅ |
| AI-7 | Ticket creation never blocked by AI | `void classifyAndStore()` after commit | AI-11 | ✅ |
| AI-8 | Key never reaches the browser | Backend-only provider; only `VITE_API_BASE_URL` is public | Vercel has exactly one env var | ✅ |

---

## 8. Outstanding work

| # | Item | Owner |
|---|---|---|
| 1 | Change the seeded admin password after the review | You |
| 2 | Replace the temporary Meta access token with a permanent System User token | You |
| 3 | Both members study `VIVA_PREPARATION.md` and `PROJECT_DEEP_DIVE.md` | Both |
