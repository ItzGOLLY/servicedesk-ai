# Review runbook — 30 minutes

> **Superseded.** This runbook was written for the mid-semester review and refers to the earlier Render-hosted database.
> The current procedure is in [`DEPLOY_FROM_SCRATCH.md`](DEPLOY_FROM_SCRATCH.md),
> which provisions the database on Neon's permanently free plan.


Everything in order, with timings. Read §1 tonight, §3 is what you actually do.

---

## 1. Tonight — four tasks

Do them in this order. **Task 0 is mandatory** — the live API is currently
down. Tasks 2 and 3 are optional polish.

### Task 0 — Restore the live API (~20 min) · **DO THIS FIRST**

**The Render database is gone.** Render's free PostgreSQL expires after 30
days; yours was created on 16 September, which is 35 days ago. The port still
answers and TLS still negotiates, but every PostgreSQL session is refused — and
because the API runs `npm run migrate` before it starts, it cannot boot at all.
This is unrelated to the platform code; the same thing would have happened
without any changes.

1. **Render dashboard** → check `servicedesk-db`. It will show as expired or
   suspended.
2. **New + → PostgreSQL** → name `servicedesk-db-2`, region **Singapore**,
   plan **Free** → Create. (Same region as the API, or the internal connection
   string will not resolve.)
3. Open the new database → **Connect** → copy the **Internal Database URL**.
4. `servicedesk-api` → **Environment** → set `DATABASE_URL` to that internal
   URL → **Save**. Render redeploys and migrations run automatically on start.
5. Wait for **Live**, then check:
   `https://servicedesk-api-cea6.onrender.com/api/health` → must say
   `"database":"connected"`.
6. **Seed the demo data.** Copy the new database's **External Database URL**,
   then from the repo:

   ```bash
   cd backend
   DATABASE_URL='<external url>' DATABASE_SSL=true \
   JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=x npm run seed
   ```

**Your old tickets are gone** (SD-1006, SD-1007 and the WhatsApp history). The
seed recreates a full demo set, so the demo is unaffected — just do not promise
the panel you will show data from September.

> **Note for the future:** a free Render database expires every 30 days. Put a
> reminder in your calendar, or move to a paid instance before the final
> submission.

### Task 1 — Prove the live site works (10 min) · **ESSENTIAL**

The platform is deployed. Open and sign in:

- **https://servicedesk-ai-two.vercel.app** → `admin@servicedesk.ai` / `Admin@12345`
- Check the sidebar now shows **Connect WhatsApp**, **Message log**, **Developers**.
- Open **Developers** → create a key called `Demo` → confirm it appears.

If the sidebar does *not* show those three items, Vercel has not finished
building. Wait five minutes and hard-refresh (Cmd+Shift+R).

### Task 2 — Make "Connect WhatsApp" actually open Meta's dialog (25 min)

Without this the page honestly says "Not configured yet" — which is
presentable, but far weaker than the dialog opening.

1. **developers.facebook.com** → your **ServiceDesk AI** app → **App settings → Basic**
   → copy **App ID** and **App Secret**.
2. **Add Product → Facebook Login for Business → Set up.**
3. **Facebook Login for Business → Settings** — set all of these to **Yes**:
   Client OAuth login · Web OAuth login · Enforce HTTPS · Embedded Browser OAuth
   Login · Use Strict Mode for redirect URIs · Login with the JavaScript SDK.
4. In **Allowed Domains for the JavaScript SDK** add:
   `https://servicedesk-ai-two.vercel.app`
   Add the same URL to **Valid OAuth Redirect URIs**.
5. **Facebook Login for Business → Configurations → Create configuration** →
   choose the **WhatsApp Embedded Signup** login variation (or the template
   named *"WhatsApp Embedded Signup Configuration With 60 Expiration Token"*).
   Copy the **configuration ID**.
6. **Render** → `servicedesk-api` → **Environment** → add:

   | Variable | Value |
   |---|---|
   | `META_APP_ID` | your App ID |
   | `META_APP_SECRET` | your App Secret |
   | `META_ES_CONFIG_ID` | the configuration ID from step 5 |
   | `PLATFORM_ENCRYPTION_KEY` | run `openssl rand -hex 32` and paste it |
   | `PLATFORM_PUBLIC_URL` | `https://servicedesk-api-cea6.onrender.com` |

   Save → wait for **Live** (~3 min).
7. Reload the site → **Connect WhatsApp** → the blue **Connect with Facebook**
   button should now be enabled. **Click it once** to confirm Meta's dialog
   opens, then close the dialog. Do not complete it — you want it fresh.

### Task 3 — Live WhatsApp messaging (10 min) · optional

Your Meta access token from September expired long ago, so WhatsApp replies
will not arrive unless you refresh it.

1. **WhatsApp → API Setup → Generate access token** → copy.
2. Render → Environment → `WHATSAPP_ACCESS_TOKEN` → paste → Save.
3. Message the test number from your phone; confirm a reply arrives.

**If you skip this**, do not attempt the live WhatsApp step in the demo. Use the
admin **Message log → Send a test message** instead, which exercises the same
inbound path without needing Meta.

### Before bed

- Open the live site once at ~8:40am so Render's free instance is awake
  (it sleeps after 15 minutes and takes ~50 s to wake).
- Have these tabs open: live site (admin), live site (second window, agent),
  GitHub repo, Render dashboard, `/api/docs`.

---

## 2. What you are claiming — say this in the first 30 seconds

> *"Last review this was a support desk. Now it is the platform underneath one.
> Businesses connect their own WhatsApp number to us through Meta's Embedded
> Signup — the same model Twilio and AiSensy use — and our original helpdesk is
> just the first application running on it."*

---

## 3. The 30-minute routine

| Time | Step | What you do | What you say |
|---|---|---|---|
| **0:00** | Open | Live URL, signed in as admin | "Deployed on Vercel, API and Postgres on Render, all from a Blueprint in the repo." |
| **0:02** | **Connect WhatsApp** | Open the page. Click **Connect with Facebook**; Meta's dialog opens; close it. | "This is the Tech Provider flow. A business authorises inside Meta's own dialog. We never see their password, and their access token never touches the browser — the browser only carries a code that expires in 30 seconds, which our server exchanges." |
| **0:05** | **The routing question** | Show the **Numbers** table — point at the *routing id* column. | "Meta sends every customer's traffic to one webhook. The request never says whose it is. We derive it from `phone_number_id`, which is unique platform-wide in our schema — so a routing bug becomes a database error, not one business reading another's messages." |
| **0:08** | **Prove isolation** | Run `scripts/platform-demo.sh` in a terminal. | "Same person, two businesses, one webhook." Show the output: two 200s, a replay, an unknown number, and a 403 for unsigned. |
| **0:11** | Show the result | Run the two SQL queries from `PLATFORM_DEMO.md` §4 | "Two tickets, two different tenants. And the same phone number is two unrelated customer accounts — Acme cannot see this person also contacted Globex." |
| **0:14** | **Developers** page | Create an API key. Show the "shown once" warning. | "This is the Twilio half. Only the hash is stored." |
| **0:16** | Use the key | `curl .../v1/me -H "Authorization: Bearer sdk_..."` then the same call with a wrong key | "Scoped to their tenant. A wrong key, a revoked key, or a session cookie all get 401 — the public API is keys only, so a malicious page can't drive their messaging." |
| **0:19** | Webhooks | Add an endpoint, show the signing secret and the delivery log | "Signed over timestamp plus body so a captured request can't be replayed, retried with backoff, then marked failed." |
| **0:21** | **The helpdesk still works** | Agent window: open a ticket, AI panel → generate draft → send | "The original product is now one tenant's app on the platform. Nothing about it broke." |
| **0:24** | Evidence | `npm test` output (193 passing) and `/api/docs` | "32 of these specifically test that one tenant cannot see another's data." |
| **0:26** | **The honest bit** | Open `docs/META_INTEGRATION_HANDBOOK.md` §1 | See §4 below — say this carefully. |
| **0:28** | GitHub | Repo, commit history, green CI | |
| **0:29** | Questions | | |

---

## 4. The approval question — the answer that matters

They **will** ask: *"So is this actually connected to Meta? Is it approved?"*

Say exactly this:

> *"Meta gives Business-type apps Standard Access automatically, so the
> integration works today — anyone we add as a tester on our app can onboard
> their own WhatsApp Business account through our flow, for real.*
>
> *What App Review grants is Advanced Access, which lets businesses with no
> relationship to our app onboard. Its prerequisite is Meta verifying a
> registered company — address, documents, a phone they call. That is a
> company-registration step, not a piece of software we failed to write.*
>
> *Everything on Meta's technical checklist is implemented. Section 5 of this
> document maps all twenty requirements to the file that implements it and the
> test that proves it."*

Then show the §5 table. That is your proof of work.

**Do not say** "we couldn't do it" or "it's blocked". The accurate framing is
*engineering complete, commercial verification pending* — and it is genuinely
true.

---

## 5. The three questions you should rehearse

**"How does a message know which business it belongs to?"**
> `phone_number_id` on Meta's payload → unique column in `wa_numbers` →
> `tenant_id`. Unique platform-wide, so collisions are impossible by
> construction, not by convention.

**"What stops me reading another business's messages?"**
> Every tenant-owned table carries `tenant_id NOT NULL`, every query is scoped
> by it, and the tenant is never taken from client input — it comes from the
> session or the API key. Ten tests attack exactly this.

**"Where do you store their access tokens?"**
> AES-256-GCM encrypted at rest. Logs carry a 12-character fingerprint, never
> the token. Production refuses to use a key with too little entropy.

---

## 6. If something breaks

| Problem | Do |
|---|---|
| Site slow / 502 | Free instance waking — wait 50 s, refresh. Keep talking. |
| "Connect with Facebook" greyed out | Meta vars not set — the page says so honestly; present it as the configuration step and move on |
| Meta dialog errors | Domain not in Allowed Domains, or not HTTPS. Skip to the isolation demo (step 0:08) — it needs no Meta |
| WhatsApp reply doesn't arrive | Token expired. Use admin → Message log → **Send a test message** instead |
| API health says database not connected | The free database expired again — Task 0 |
| Everything is down | `cd backend && npm run dev`, `cd frontend && npm run dev`, demo on localhost — and say so openly. Everything except the live-URL claim still works |

**Rollback**, only if the live site is broken and you cannot fix it:
Render → `servicedesk-api` → Deploys → find the deploy for commit `3782540`
→ **Redeploy**. That is the version from your last review.

---

## 7. Accounts

| Role | Email | Password |
|---|---|---|
| Admin | admin@servicedesk.ai | Admin@12345 |
| Agent | priya.agent@servicedesk.ai | Agent@12345 |
| Customer | rohan@example.com | Customer@12345 |

**Live:** https://servicedesk-ai-two.vercel.app ·
API https://servicedesk-api-cea6.onrender.com/api ·
Docs https://servicedesk-api-cea6.onrender.com/api/docs
