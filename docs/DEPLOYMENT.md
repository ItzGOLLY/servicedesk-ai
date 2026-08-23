# Deployment Guide

Three tiers, three platforms, all on free plans:

| Tier | Platform | What is deployed |
|---|---|---|
| Database | Supabase | Managed PostgreSQL 15 |
| API | Render | Express container |
| Frontend | Vercel | React static build |

Deploy in that order — the API needs the database URL, and the frontend needs the API URL.

> **Status:** not yet deployed. These steps have not been executed against live accounts; they are written from the actual configuration in the repository. When you deploy, record the real URLs in the README and in `FINAL_COMPLIANCE_CHECKLIST.md`.

---

## Step 1 — Database (Supabase)

1. Create an account at [supabase.com](https://supabase.com) and create a new project.
2. Choose a region close to Chennai (Singapore or Mumbai) to keep latency low.
3. Save the database password you set — it appears in the connection string and cannot be recovered later.
4. Go to **Project Settings → Database → Connection string → URI** and copy the **pooled** connection string (port 6543). Pooling matters because the API may run more than one instance and Supabase caps direct connections.

The string looks like:

```
postgresql://postgres.abcdefgh:YOUR-PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
```

You do not create any tables by hand — the migration does it in step 2.

---

## Step 2 — API (Render)

1. Create an account at [render.com](https://render.com) and connect your GitHub account.
2. **New → Web Service**, select `ItzGOLLY/servicedesk-ai`.
3. Configure:

| Setting | Value |
|---|---|
| Name | `servicedesk-ai-api` |
| Region | Singapore |
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instance Type | Free |

4. Add environment variables under **Environment**:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | The pooled Supabase URI from step 1 |
| `DATABASE_SSL` | `true` |
| `JWT_ACCESS_SECRET` | Output of `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | A **different** `openssl rand -base64 48` |
| `ACCESS_TOKEN_TTL` | `15m` |
| `REFRESH_TOKEN_TTL` | `7d` |
| `CORS_ORIGIN` | Your Vercel URL (set after step 3) |
| `AI_PROVIDER` | `fallback`, or `anthropic` if you have a key |
| `AI_API_KEY` | Your Anthropic key, only if `AI_PROVIDER=anthropic` |
| `AI_MODEL` | `claude-sonnet-5` |

Generate the secrets:

```bash
openssl rand -base64 48
```

**Never** reuse the values from `.env.example` — they are placeholders, and anyone reading the repository can see them.

5. Deploy. When the build finishes, run the migration and seed from the Render **Shell** tab:

```bash
npm run migrate
```

```bash
npm run seed
```

6. Verify:

```bash
curl https://servicedesk-ai-api.onrender.com/api/health
```

Expect `{"success":true,"data":{"status":"ok","database":"connected", ...}}`.

---

## Step 3 — Frontend (Vercel)

1. Create an account at [vercel.com](https://vercel.com) and import `ItzGOLLY/servicedesk-ai`.
2. Configure:

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | `frontend` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

3. Add one environment variable:

| Key | Value |
|---|---|
| `VITE_API_BASE_URL` | `https://servicedesk-ai-api.onrender.com/api` |

Note the `/api` suffix — the client appends paths like `/auth/login` directly.

> Only `VITE_`-prefixed variables are exposed to the browser, and everything exposed to the browser is **publicly readable in the built JavaScript**. Never put a secret here. The AI API key belongs on Render, not Vercel.

4. Deploy, then copy the resulting URL (e.g. `https://servicedesk-ai.vercel.app`).

`frontend/vercel.json` rewrites all paths to `index.html`, so deep links such as `/admin/reports` work on a hard refresh instead of returning 404.

---

## Step 4 — Close the CORS loop

Go back to Render, set `CORS_ORIGIN` to your exact Vercel URL, and redeploy.

```
CORS_ORIGIN=https://servicedesk-ai.vercel.app
```

**No trailing slash, and `https` not `http`** — the browser compares the origin string exactly.

For preview deployments as well, comma-separate:

```
CORS_ORIGIN=https://servicedesk-ai.vercel.app,https://servicedesk-ai-git-dev.vercel.app
```

A wildcard `*` will not work here: the app sends credentials, and browsers reject a wildcard origin on credentialed requests.

---

## Step 4b — WhatsApp (optional)

**The channel works without this step.** With `WHATSAPP_PROVIDER=simulator`
(the default) messages are recorded and shown in the admin console but not
delivered to a phone, so the whole flow is demonstrable with no external
account. Do the following only if you want real delivery.

1. Create a Twilio account and open the **WhatsApp Sandbox** (Messaging → Try it
   out → Send a WhatsApp message). Join it by sending the given code from your
   own phone — this takes minutes and needs no Meta business verification.
2. On Render, set:

| Variable | Value |
|---|---|
| `WHATSAPP_PROVIDER` | `twilio` |
| `WHATSAPP_ACCOUNT_SID` | Your Twilio Account SID |
| `WHATSAPP_AUTH_TOKEN` | Your Twilio Auth Token |
| `WHATSAPP_FROM_NUMBER` | The sandbox number, e.g. `+14155238886` |
| `WHATSAPP_WEBHOOK_URL` | `https://<your-api>.onrender.com/api/whatsapp/webhook` |

3. In the Twilio sandbox settings, set **"When a message comes in"** to that same
   webhook URL, method `POST`.

`WHATSAPP_WEBHOOK_URL` must match what Twilio calls **character for character** —
it is part of the request signature, and a mismatch makes every webhook fail
verification with `403`.

> The sandbox number expires after a period of inactivity and shows Twilio
> branding. That is acceptable for a demonstration; production use requires a
> verified WhatsApp Business number.

**Verify:** send a WhatsApp message to the sandbox number. A ticket should
appear in the queue within seconds, and you should receive a confirmation
naming the reference.

**If it does not work,** open the admin WhatsApp console — it states which
provider is active, and the message log shows failed sends with their error.

---

## Step 5 — Keep the free tier awake

Render free instances sleep after ~15 minutes idle (first request then takes ~50 s), and Supabase pauses a project after ~7 days idle. One scheduled ping solves both.

Create a free monitor at [uptimerobot.com](https://uptimerobot.com):

| Setting | Value |
|---|---|
| Monitor Type | HTTP(s) |
| URL | `https://servicedesk-ai-api.onrender.com/api/health` |
| Interval | 10 minutes |

The health endpoint queries the database, so the ping keeps both tiers active.

---

## Verification checklist

Run through this after every deployment:

| # | Check | Expected |
|---|---|---|
| 1 | `GET /api/health` | `200` with `"database": "connected"` |
| 2 | Open the Vercel URL | Landing page renders |
| 3 | Register a new account | Redirects to the customer dashboard |
| 4 | Open DevTools → Network on login | Response sets the `sd_refresh` cookie; no CORS error |
| 5 | Create a ticket | Appears with a reference; category and sentiment populate on reload |
| 6 | Sign in as an agent | The ticket appears in the queue |
| 7 | Generate an AI draft | Draft returned; `usedFallback` reflects your configuration |
| 8 | Sign in as admin | Dashboard charts render with real numbers |
| 9 | Hard-refresh `/admin/reports` | Page loads, not a 404 |
| 10 | Open on a phone | Sidebar collapses; tables become cards |
| 11 | Search the built JS for your AI key | **No match** — `curl <vercel-url>/assets/index-*.js \| grep sk-` |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Browser console: "blocked by CORS policy" | `CORS_ORIGIN` does not exactly match the frontend origin | Set the exact origin on Render, no trailing slash, then redeploy |
| Login succeeds but the session is lost on refresh | Refresh cookie not stored | Both tiers must be HTTPS; `NODE_ENV=production` is required so the cookie is sent with `Secure` and `SameSite=None` |
| API returns 503 | Database unreachable or the Supabase project is paused | Open the Supabase dashboard to resume it; confirm `DATABASE_SSL=true` |
| First request takes ~50 s | Render free instance was asleep | Expected; the keep-alive ping in step 5 prevents it |
| `relation "users" does not exist` | Migration never ran | Run `npm run migrate` in the Render shell |
| `self-signed certificate in certificate chain` | Managed Postgres requires TLS | Set `DATABASE_SSL=true` |
| Build fails: "Cannot find module" | Wrong root directory | Root must be `backend` on Render and `frontend` on Vercel |
| Deep link 404s on refresh | SPA rewrite missing | Confirm `frontend/vercel.json` is deployed |
| `Missing required environment variable` at boot | A variable was not set | The error names the variable; add it and redeploy |
| Charts show axes but no bars | Recharts animation under StrictMode | Already fixed via `isAnimationActive={false}`; ensure you deployed the current `main` |
| WhatsApp webhook returns 403 | Signature mismatch | `WHATSAPP_WEBHOOK_URL` must exactly equal the URL configured at the provider |
| Messages appear in the console but no phone receives them | Still on the simulator | Set `WHATSAPP_PROVIDER=twilio` with full credentials and redeploy |
| WhatsApp messages create duplicate tickets | Would indicate the idempotency constraint is missing | Confirm `002_whatsapp.sql` was applied — `npm run migrate` |

---

## Local development

```bash
git clone https://github.com/ItzGOLLY/servicedesk-ai.git
cd servicedesk-ai
```

Backend:

```bash
cd backend && npm install && cp .env.example .env
```

Point `DATABASE_URL` at a local PostgreSQL database, then:

```bash
npm run migrate && npm run seed && npm run dev
```

Frontend, in a second terminal:

```bash
cd frontend && npm install && cp .env.example .env && npm run dev
```

Open `http://localhost:5173`. Seeded accounts:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@servicedesk.ai` | `Admin@12345` |
| Agent | `priya.agent@servicedesk.ai` | `Agent@12345` |
| Customer | `rohan@example.com` | `Customer@12345` |

**Change the admin password immediately after seeding a production database.** These credentials are published in this repository.
