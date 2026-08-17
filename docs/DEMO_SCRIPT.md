# Demonstration Script

A 7–9 minute walkthrough covering every item on the A2 final demonstration checklist. Everything below uses real working functionality — there is no staged data and no rehearsed screenshot.

---

## Before you start

| # | Preparation | Why |
|---|---|---|
| 1 | Open the live URL **5 minutes early** and leave the tab loaded | Render free instances sleep; the first request takes ~50 s |
| 2 | Confirm `/api/health` returns `"database": "connected"` | Catches a paused Supabase project before the room is watching |
| 3 | Have three browser profiles or windows ready, one signed in per role | Avoids spending demo time on sign-out and sign-in |
| 4 | Open the GitHub repository in a spare tab | Checklist item 16 |
| 5 | Open the Supabase table editor in another tab | Checklist item 14 |
| 6 | Decide who presents which half | Both members must speak |

**Fallback if the internet fails:** run locally with `npm run dev` in both folders. Say clearly that you are showing the local instance and that the deployment is live — do not imply the local one is the deployment.

---

## The script

### 1. Open the public URL — 30 s

Show the landing page and the address bar.

> "This is deployed on Vercel, backed by an API on Render and a PostgreSQL database on Supabase. Nothing runs on our machines, and there is no localhost anywhere in this demonstration."

**Covers:** Live URL · Cloud Deployment

### 2. Register and sign in as a Customer — 45 s

Register a genuinely new account in front of them.

> "Registration always creates a Customer. Privileged roles can only be granted by an administrator, so nobody can self-register as an admin. Passwords are stored as bcrypt hashes — never plaintext."

**Covers:** Registration/Login

### 3. Raise a complaint — 60 s

Create a ticket, using wording with obvious signal:

> **Subject:** Payment deducted but order still pending
> **Description:** My payment of ₹2,499 was deducted yesterday but my order #4471 is still showing as pending. I have received no confirmation. This is urgent as it was a gift.

Leave category and priority blank.

> "I have deliberately left category and priority empty. The customer is never blocked waiting for the AI."

**Covers:** Core Workflow

### 4. Show the AI classification — 45 s

Reload the ticket. Point at the badges.

> "The system classified this as Billing, Urgent priority, Negative sentiment, and wrote a one-line summary. Importantly, that happened *after* the ticket was saved — classification runs in the background, so if the AI service is down, ticket creation still succeeds."

**Covers:** Core Workflow · the AI feature

### 5. Prove role isolation — 30 s

In the customer window, edit the URL to another customer's ticket id.

> "A customer cannot reach another customer's ticket. Note it returns not-found rather than forbidden, so ticket ids cannot be probed to discover what exists. This is enforced in the API, not by hiding buttons — we have 26 automated tests that call the API directly with the wrong role."

**Covers:** Role-based Access

### 6. Switch to the Support Agent — 45 s

Show the queue.

> "The agent sees every customer's tickets, ordered by priority, with server-side filters on status, priority, category, agent and sentiment, plus full-text search across reference, subject, customer and body."

Filter by Urgent, then search a keyword. Open the new ticket.

**Covers:** Role-based Access · Core Workflow

### 7. Use AI assistance — 75 s

Open the AI panel. Click **Generate** under Draft reply.

> "The assistant drafts a reply. It is not sent — it goes into a box the agent has to read."

Click **Insert into reply**, then visibly edit the text.

> "The agent inserts it into their own reply box, edits it, and sends. There is no path in this system where AI-written text reaches a customer without a person pressing send. That is a deliberate design decision: a model can be confidently wrong about a specific customer's order, and a human should own what the business says."

Send the reply.

> "Sending set the first-response timestamp and moved the ticket to In Progress automatically."

**Covers:** the AI feature · Core Workflow

### 8. Move the ticket through its lifecycle — 30 s

Assign it, then set the status to **Resolved**.

> "Transitions are validated on the server against a single lifecycle table. If I tried to jump straight from New to Resolved, the API returns 422 and explains which transitions are allowed."

Show the timeline in the sidebar.

**Covers:** Core Workflow

### 9. Switch to Admin — 60 s

Open the admin dashboard.

> "Every number and every chart here is a SQL aggregate computed at request time. Nothing is hard-coded."

Prove it: point out the total, then reload after mentioning the ticket you just created is included.

Walk through: volume trend, tickets by category, sentiment distribution, priority, agent workload, and the AI usage panel.

> "The AI panel counts fallback-produced suggestions separately, so the figure stays honest when the provider is unavailable."

**Covers:** Dashboard & Reports

### 10. Reports and administration — 45 s

Open **Reports**, export the CSV, then show **Users**, **Categories** and **Activity**.

> "The activity log records every privileged action with the actor, entity and timestamp."

**Covers:** Dashboard & Reports · Administrator module

### 11. Responsive design — 30 s

Open developer tools and switch to a phone viewport, or use your actual phone.

> "The sidebar collapses to a menu and the ticket table becomes stacked cards. Same application, same API."

**Covers:** Responsive Design

### 12. Show the cloud database — 30 s

Switch to the Supabase table editor and open `tickets`.

> "This is the managed PostgreSQL instance. Eight tables, applied by versioned SQL migrations. The ER diagram in our documentation is derived from those migration files, so it cannot drift from what you are looking at."

**Covers:** Cloud Database

### 13. Show the architecture — 45 s

Open `docs/CLOUD_ARCHITECTURE.md`.

> "Three independently deployed tiers. The browser talks to Vercel for assets and to Render for the API — it never touches the database, and it never talks to the AI provider. The API key exists only as a Render environment variable and is not in the repository or the browser bundle."

**Covers:** Cloud Deployment

### 14. Show GitHub — 30 s

> "One repository, commit history through the semester, meaningful README, and a .gitignore that excludes .env. No secret has ever been committed."

**Covers:** GitHub Repository

### 15. Show the tests — 30 s

Run `npm test`, or show `docs/TESTING.md`.

> "92 automated tests against a real PostgreSQL database — authentication, authorisation boundaries, ticket CRUD, every lifecycle transition, and AI failure handling. One of them proves that if classification throws, the ticket is still created."

**Covers:** Testing

---

## If they ask you to break it

Rehearse these — being asked to demonstrate a failure is a good sign.

| Request | What to do | What to say |
|---|---|---|
| "Turn off the AI." | Set `AI_PROVIDER=fallback` on Render, or show it already running that way | "Everything still works. The panel tells the agent the fallback produced this." |
| "Log in as a customer and open the admin dashboard." | Edit the URL to `/admin` | "The route guard redirects, and the API returns 403 regardless — the guard is convenience, not security." |
| "Show me the API rejecting that." | `curl` the admin endpoint with a customer token | Show the `403` payload |
| "Make an invalid status change." | Try New → Resolved | Show the `422` naming the permitted transitions |
| "Add a category." | Admin → Categories → Add | Then show it appearing in the ticket form |
| "Deactivate a user who is signed in." | Deactivate, then act in the other window | "Access stops immediately — the user row is re-read on every request, not trusted from the token." |

---

## Timing

| Section | Time |
|---|---|
| 1–5 Customer journey | 3:30 |
| 6–8 Agent and AI | 2:30 |
| 9–11 Admin and responsive | 2:15 |
| 12–15 Infrastructure and evidence | 2:15 |
| **Total** | **~10:30** |

If you are held to strictly 5 minutes, cut sections 10 and 15 and shorten 13 — but keep 4, 7 and 9, which are the ones that distinguish this project.
