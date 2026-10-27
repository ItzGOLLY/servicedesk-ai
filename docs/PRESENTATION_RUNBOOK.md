# Presentation runbook — 28 October 2026

Rehearsed end to end on 27 October against the live deployment. Every step
below was performed and worked; the screenshots in `screenshots/` are from
that run.

---

## 0. The one thing that can embarrass you

**A cold API takes 33 seconds to answer.** Measured, not estimated:

| | Time |
|---|---|
| First request after idle | **32.6 s** |
| Every request after that | **0.18 s** |

Render's free instance sleeps after 15 minutes, and Neon's compute suspends
after about five. If you open the site cold in front of the panel, it will
appear frozen for half a minute.

**Therefore: open the live site 5 minutes before you present and click
around.** That alone removes the risk.

Better, if you have ten minutes spare: uptimerobot.com → free account →
**Add New Monitor** → HTTP(s) → `https://servicedesk-api-cea6.onrender.com/api/health`
→ every 5 minutes. Then it never sleeps.

---

## 1. Before you walk in

```bash
cd ~/Cloud_Computing_Proj
./scripts/set-live-urls.sh \
  https://servicedesk-api-cea6.onrender.com \
  https://servicedesk-ai-two.vercel.app
```

Seven checks must say `ok`. If any fails, the script tells you what to fix and
changes nothing.

**Tabs to have open, in this order:**

1. `https://servicedesk-ai-two.vercel.app` — signed in as **admin**
2. The same site in a second window — signed in as **agent**
3. `https://servicedesk-api-cea6.onrender.com/api/docs`
4. `https://github.com/ItzGOLLY/servicedesk-ai`

---

## 2. Accounts

| Role | Email | Password |
|---|---|---|
| Admin | `admin@servicedesk.ai` | `Admin@12345` |
| Agent | `priya.agent@servicedesk.ai` | `Agent@12345` |
| Customer | `rohan@example.com` | `Customer@12345` |

All three verified working against the live site today.

---

## 3. The demo, in order

Rehearsed timings in brackets.

### Step 1 — It is actually deployed *(1 min)*

Open the live URL. While it loads:

> *"This is running on public cloud infrastructure — the React frontend on
> Vercel's CDN, the API on Render, and a managed PostgreSQL on Neon. Nothing
> runs on localhost. The infrastructure is defined in a Blueprint file in the
> repository, so the whole stack is reproducible."*

### Step 2 — A customer raises a complaint *(2 min)*

Sign in as the **customer** → **New ticket**. Type something realistic:

> *My payment was deducted twice this morning and the order is still showing
> as pending. Please refund the duplicate charge urgently.*

Submit. The ticket appears immediately with a reference.

> *"The response came back straight away. Classification happens afterwards,
> in the background, so a slow AI provider can never delay a customer."*

### Step 3 — The agent sees it already triaged *(2 min)* ← **your strongest moment**

Switch to the **agent** window → **Ticket queue** → open the new ticket.

Point at the AI assistance panel:

> *"Nobody touched this. The system read the complaint and classified it as
> **Billing**, priority **Urgent**, and wrote the summary. The agent can
> override any field — the confidence score is shown precisely so they know
> when to."*

### Step 4 — AI drafts, the human decides *(2 min)*

In the AI panel → **Generate** under *Draft reply* → the draft appears →
**Insert into reply**.

> *"The draft goes into the agent's reply box, not to the customer. Notice the
> line underneath: 'This started from an AI draft. Edit it in your own words
> before sending.' The AI never messages a customer — that is a design
> decision, not a limitation."*

Edit a sentence, then **Send reply**. Change status to **In progress** and
show the timeline recording it.

### Step 5 — WhatsApp *(2 min)*

Admin window → **Message log**.

> *"WhatsApp is the intake channel a small business's customers actually use.
> This deployment runs the simulator provider, which exercises the identical
> inbound path — the banner says so rather than hiding it."*

Use **Send a test message**: enter a number and a complaint, press **Deliver
message**. A ticket is raised and the auto-reply appears in the log with the
reference.

Then type `STATUS` as the same number to show the keyword handling.

### Step 6 — It is a platform, not just an app *(3 min)* ← **the new material**

Sign out first. On the **public landing page**, point at *Connect your
WhatsApp* — it is offered before any login, deliberately.

1. **/signup** → fill in a business name, your name, an email, a password →
   **Create workspace**. You land straight on Connect WhatsApp.
2. Point out: this new workspace has **zero tickets**. It cannot see the demo
   business's data at all.
3. **Connect WhatsApp** → show the two routes: *Connect with Facebook*
   (Embedded Signup) and *Connect manually*.
4. **Need help?** → the setup guide. Scroll it. The webhook URL on that page is
   rendered from the deployment's own configuration, not typed into the prose.
5. Sign back in as admin → **Developers** → the issued API key and the webhook
   endpoint.

> *"Since the last review this became the platform underneath the support
> desk. A business signs itself up, gets its own workspace, and connects its
> own WhatsApp number — through Meta's Embedded Signup, or with credentials it
> already holds. One webhook serves every business, routed by the phone number
> the message arrived on, which is unique platform-wide in our schema, so a
> routing bug becomes a database error rather than one business reading
> another's messages. 53 tests cover that layer."*

**If they ask what you learned, this is the answer to give:**

> *"Building the self-signup is what exposed our worst defect. Multi-tenancy
> scoped the writes and the message routing, but not the reads — so an admin of
> any workspace could list every workspace's tickets, users, audit log and
> dashboard figures. We found it the first time we signed up a second business
> and it showed us the first one's tickets. We scoped twenty-nine queries
> across seven modules and added ten tests, and we verified each fix by
> reverting it and watching its own test fail. It was invisible with one
> tenant — and public signup is exactly the feature that would have exposed
> it in production."*

That is in the report as Table 17.2.

### Step 7 — Evidence *(2 min)*

- **Admin overview** — every figure is a SQL aggregate at request time
- **Reports** → CSV export
- **Activity** → the audit log
- `/api/docs` → *"generated from the same schemas that validate requests, so
  the documentation cannot drift"*
- GitHub → commit history, green CI badge

> *"214 automated tests, run against a real PostgreSQL using the production
> migration files — not mocks. A mock would accept data a CHECK constraint
> rejects."*

### Step 8 — Responsive *(30 s)*

Narrow the browser, or open the site on your phone. Sidebar collapses, tables
become cards.

---

## 4. Questions you should expect

**"How does a message know which business it belongs to?"**
> `phone_number_id` on Meta's payload → a unique column in `wa_numbers` →
> `tenant_id`. Unique platform-wide, so collisions are impossible by
> construction rather than by convention.

**"What stops one business reading another's data?"**
> Every tenant-owned table carries `tenant_id NOT NULL`, every query is scoped
> by it, and the tenant is never taken from client input — it comes from the
> session or the API key. Ten tests attack exactly this.

**"Is it really connected to Meta? Is it approved?"**
> Meta grants Business apps Standard Access automatically, so the integration
> works today for anyone with a role on our app. App Review grants Advanced
> Access, which lets the general public onboard; its prerequisite is verifying
> a registered company. That is a company-registration step, not software we
> failed to write. `docs/META_INTEGRATION_HANDBOOK.md` maps all twenty of
> Meta's technical requirements to the file and the test that satisfy each.

**"Where are the AI answers coming from?"**
> Honestly: the rule-based fallback, because no API key is configured on this
> deployment. The panel says so. Every provider failure converges there, and
> each suggestion is stored with a flag recording which engine produced it, so
> the usage figures stay truthful. The LLM path is the same interface.

**"Why is the sentiment 'Neutral' on an angry complaint?"**
> That is the offline keyword classifier being imprecise. We measured it
> rather than claiming it: 76.7% category accuracy against a 20% baseline.
> The LLM path does better; we report the number we actually measured.

**"Show me security."**
> bcrypt at cost 12; a 15-minute token held in memory, never in browser
> storage; refresh token in an httpOnly cookie; authorisation enforced twice,
> at the route and on the record; 404 rather than 403 for another customer's
> ticket so existence is not disclosed; parameterised SQL only; webhook
> signatures verified in constant time; third-party tokens encrypted at rest.

---

## 5. If something breaks

| Problem | What to do |
|---|---|
| Page hangs on first load | The instance is waking. Say *"free tier, it sleeps when idle"* and keep talking — it clears in ~33 s |
| Login fails | Hard-refresh (Cmd+Shift+R). If it persists, run the verification script |
| AI draft does nothing | Check you clicked **Generate** under *Draft reply*, not **Regenerate** under *Summary* |
| WhatsApp test does nothing | Number must be international format, e.g. `+919876543210` |
| Whole site down | `cd backend && npm run dev`, `cd frontend && npm run dev` — demo on localhost and say so openly |

---

## 6. What not to oversell

Say these plainly if asked. They are already written into the report.

- File attachments and cloud object storage are **not** implemented.
- Refresh tokens cannot be individually revoked; deactivation is the mitigation.
- The frontend has **no automated tests**; it was verified manually.
- Meta Tech Provider approval is **not held** — that needs a registered company.
- The AI answers currently come from the **rule-based fallback**, not an LLM.

Stating a limitation before you are asked reads as competence. Being caught
overstating one does the opposite.
