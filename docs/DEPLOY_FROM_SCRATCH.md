# Deploy from scratch — new Render account, start to finish

Assumes nothing exists. Follow top to bottom; do not skip ahead, because each
part needs a value produced by the one before it.

**Total: ~45 minutes** for a working live site. Parts 6 and 7 (WhatsApp and
Embedded Signup) add ~35 minutes and can be done later.

---

## Part 0 — Before you start

| You need | Why |
|---|---|
| GitHub account with the repo pushed | Render and Vercel deploy from it |
| A new Render account | Database + API |
| A Vercel account | Frontend |
| (Parts 6–7) A Meta developer account | WhatsApp |

**Keep a scratch note open.** You will produce four values and reuse each
several times:

```
API URL     = ____________________________   (Part 1)
DB external = ____________________________   (Part 2)
SITE URL    = ____________________________   (Part 3)
ENCRYPT KEY = ____________________________   (Part 1, from openssl)
```

Generate the encryption key now and paste it into the note:

```bash
openssl rand -hex 32
```

---

## Part 1 — Render: database + API together (~15 min)

The repo contains `render.yaml`, a Blueprint that creates both at once and
wires the database connection automatically. Use it rather than creating
services by hand — it also pins both to the **same region**, which is required
for the internal connection to resolve.

1. **render.com** → **Get Started** → **Sign in with GitHub** → authorise.
2. Dashboard → **New +** → **Blueprint**.
3. **Connect** your `servicedesk-ai` repository. If it is not listed:
   *Configure account* → grant Render access to it.
4. Branch: **main**. Render reads `render.yaml` and shows two resources:
   `servicedesk-db` and `servicedesk-api`. Give the blueprint any name.
5. **It will prompt for 18 environment variables.** Fill in only these three:

   | Variable | Value |
   |---|---|
   | `CORS_ORIGIN` | `http://localhost:5173` — a placeholder; corrected in Part 4 |
   | `PLATFORM_ENCRYPTION_KEY` | the `openssl rand -hex 32` value from your note |
   | `WHATSAPP_PROVIDER` | `simulator` |

   **Leave every other box empty.** They are optional; empty values make the
   app use its offline providers, and everything still works. You will fill the
   WhatsApp and Meta ones in Parts 6 and 7.

   *Verified:* with exactly these three set, the API boots in production mode,
   serves `/api/health` as connected, signs users in, answers CORS preflights,
   and the Connect WhatsApp page reports `configured: false` honestly instead
   of erroring.

6. **Apply** / **Create**. Build takes ~4 minutes.

   What happens: `npm ci --include=dev && npm run build`, then on start
   `npm run migrate && npm start`. Migrations run automatically on every boot,
   so the schema is always current.

7. When it is **Live**, open `servicedesk-api` and copy the URL at the top —
   it looks like `https://servicedesk-api-xxxx.onrender.com`.
   **Write it into your note as API URL.**

8. Check it:

   ```
   https://<API URL>/api/health
   ```

   Must show `"database":"connected"`. If it does not, go to **Troubleshooting**.

> **Free tier facts you must know**
> - The database **expires after 30 days**. Diarise it. When it expires the API
>   stops booting entirely, because migrations cannot run.
> - The web service **sleeps after 15 minutes idle** and takes ~50 s to wake.

---

## Part 2 — Seed the demo data (~5 min)

Render's free plan has no Shell, so run this from your laptop.

1. Render → **servicedesk-db** → **Connect** → copy the **External Database
   URL** (starts `postgresql://`). Put it in your note.
2. In the repo:

   ```bash
   cd backend
   DATABASE_URL='<paste external url>' DATABASE_SSL=true \
   JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=x npm run seed
   ```

   `JWT_*` just need to be non-empty for the config loader; the seed does not
   use them.

3. Expect lines for `workspace ready (demo)`, `categories ready (5)`,
   `admin ready`, `agents ready (2)`, `customers ready (4)` and
   `tickets created (6)`, ending in `done`.

   The output is JSON rather than coloured text, because `NODE_ENV` is
   production — that is normal. Running it a second time prints
   `tickets already present — skipping`; the seed is idempotent, so nothing
   is duplicated.

---

## Part 3 — Vercel: the frontend (~10 min)

1. **vercel.com** → **Sign up with GitHub**.
2. **Add New → Project** → import `servicedesk-ai`.
3. Settings on the import screen:

   | Setting | Value |
   |---|---|
   | Framework Preset | **Vite** |
   | Root Directory | click **Edit** → select **`frontend`** |
   | Build Command | leave default |
   | Output Directory | leave default |

4. Expand **Environment Variables** and add exactly one:

   | Name | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `<API URL>/api` |

   So: `https://servicedesk-api-xxxx.onrender.com/api` — **with `/api` on the
   end**.

5. **Deploy** (~2 min). Copy the resulting URL, e.g.
   `https://servicedesk-ai-xxxx.vercel.app`. **Write it into your note as
   SITE URL.**

> Vite bakes environment variables in **at build time**. If you ever change
> `VITE_API_BASE_URL`, you must redeploy — changing it alone does nothing.

---

## Part 4 — Let them talk to each other (~5 min)

Until this is done, login fails with a network error.

1. Render → `servicedesk-api` → **Environment**.
2. Edit `CORS_ORIGIN` → set it to your **SITE URL**, exactly:

   ```
   https://servicedesk-ai-xxxx.vercel.app
   ```

   No trailing slash. `https`, not `http`.
3. While you are here, also set:

   | Variable | Value |
   |---|---|
   | `PLATFORM_PUBLIC_URL` | your **API URL** |

4. **Save changes** → Render redeploys (~2 min).

---

## Part 5 — Checkpoint: confirm it works (~5 min)

Run this from the repo root, substituting your two URLs:

```bash
API="https://servicedesk-api-xxxx.onrender.com"
SITE="https://servicedesk-ai-xxxx.vercel.app"

echo "health:"; curl -s $API/api/health; echo
echo "CORS:";   curl -s -o /dev/null -D - -X OPTIONS $API/api/auth/login \
  -H "Origin: $SITE" -H "Access-Control-Request-Method: POST" | grep -i access-control-allow-origin
echo "login:";  curl -s -X POST $API/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@servicedesk.ai","password":"Admin@12345"}' | head -c 60
```

You want: `"database":"connected"`, an `access-control-allow-origin` echoing
your SITE URL, and a response containing `accessToken`.

Then open **SITE URL** in a browser and sign in:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@servicedesk.ai` | `Admin@12345` |
| Agent | `priya.agent@servicedesk.ai` | `Agent@12345` |
| Customer | `rohan@example.com` | `Customer@12345` |

The admin sidebar should show **Connect WhatsApp**, **Message log** and
**Developers**. If it does not, Vercel built an older commit — redeploy it.

**At this point you have a complete working live deployment.** Parts 6 and 7
are WhatsApp, which is additive.

---

## Part 6 — WhatsApp messaging via Meta (~20 min)

This makes real WhatsApp messages raise tickets and real replies reach phones.

### 6a — Create the Meta app

1. **developers.facebook.com** → log in → **My Apps → Create App**.
2. Use case **Other** → type **Business** → name `ServiceDesk AI` → Create.
3. **Add product → WhatsApp → Set up.** Meta creates a test WhatsApp Business
   account and a test sender number.

### 6b — Collect five values

| Value | Where |
|---|---|
| **Phone number ID** | WhatsApp → **API Setup**, under the test "From" number |
| **Test number** | same place |
| **Access token** | same page → **Generate** — ⚠️ **expires in 24 h**, see 6e |
| **App Secret** | **App settings → Basic → App Secret → Show** |
| **Verify token** | you invent it, e.g. `servicedesk-verify-2026` |

Still on **API Setup**, under **To** → **Manage phone number list** → add your
own phone → enter the OTP WhatsApp sends. Add your teammate's too (max 5).

### 6c — Set them on Render **before** touching the webhook

Render → `servicedesk-api` → Environment:

| Variable | Value |
|---|---|
| `WHATSAPP_PROVIDER` | `meta` |
| `WHATSAPP_ACCESS_TOKEN` | the generated token |
| `WHATSAPP_PHONE_NUMBER_ID` | the phone number ID |
| `WHATSAPP_APP_SECRET` | the app secret |
| `META_APP_SECRET` | **the same app secret** (the platform webhook uses this one) |
| `WHATSAPP_VERIFY_TOKEN` | your invented string |
| `WHATSAPP_FROM_NUMBER` | the test number, e.g. `+15551234567` |

Save → wait for **Live**. Meta's webhook check calls your API, so it must be
running with the verify token first.

### 6d — Point Meta at your API

WhatsApp → **Configuration** → Webhook → **Edit**:

| Field | Value |
|---|---|
| Callback URL | `<API URL>/api/webhooks/meta` |
| Verify token | exactly your `WHATSAPP_VERIFY_TOKEN` |

**Verify and save.** Then **Webhook fields → Manage** → subscribe to:

- **`messages`** — inbound customer messages
- **`account_update`** — bans and restrictions on a connected account

Finally, the step Meta's dashboard does **not** do for you. Get your WhatsApp
Business Account ID from WhatsApp → API Setup, then:

```bash
curl -X POST "https://graph.facebook.com/v22.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
```

`{"success":true}` means done. **Without this, nothing is ever delivered and
nothing tells you why.**

### 6e — Test

WhatsApp the test number from your verified phone:

> my payment was deducted but the order is still pending

A reply naming `SD-nnnn` should arrive within seconds. Then send `STATUS`.
Sign in as the agent, reply from the web app, and watch it reach your phone.

If nothing arrives: admin → **Message log** shows every inbound message and the
exact error on each outbound.

### ⚠️ The token expires in 24 hours

Either regenerate it each day (API Setup → Generate → paste into Render), or
make a permanent one: **business.facebook.com/settings → Users → System users
→ Add** (Admin) → **Add assets** → your app → Full control → **Generate token**
→ expiry **Never**, permissions `whatsapp_business_messaging` and
`whatsapp_business_management`.

---

## Part 7 — Embedded Signup: the platform demo (~15 min)

This is what makes "Connect WhatsApp" open Meta's real onboarding dialog, so
*other* businesses can join your platform.

1. Meta app → **Add product → Facebook Login for Business → Set up.**
2. **Facebook Login for Business → Settings** — set **all** of these to **Yes**:
   - Client OAuth login
   - Web OAuth login
   - Enforce HTTPS
   - Embedded Browser OAuth Login
   - Use Strict Mode for redirect URIs
   - Login with the JavaScript SDK
3. **Allowed Domains for the JavaScript SDK** → add your **SITE URL**.
   Add the same URL to **Valid OAuth Redirect URIs**.
   **HTTPS only — localhost will not work.**
4. **Configurations → Create configuration** → choose the **WhatsApp Embedded
   Signup** login variation (or the template named *"WhatsApp Embedded Signup
   Configuration With 60 Expiration Token"*). Copy the **configuration ID**.
5. Render → Environment → add:

   | Variable | Value |
   |---|---|
   | `META_APP_ID` | App settings → Basic → App ID |
   | `META_ES_CONFIG_ID` | the configuration ID from step 4 |

   (`META_APP_SECRET` and `PLATFORM_ENCRYPTION_KEY` are already set.)
   Save → wait for **Live**.

6. Open **SITE URL** → sign in as admin → **Connect WhatsApp**. The blue
   **Connect with Facebook** button should now be enabled. Click it — Meta's
   dialog opens.

### To demo a *real* third-party business onboarding

Meta gives Business-type apps **Standard Access** automatically, so anyone with
a role on your app can complete the flow for real:

1. Meta app → **App roles → Roles → Add People** → add your teammate as
   **Tester**. They accept the invitation.
2. They open your SITE URL, go to **Connect WhatsApp**, and complete Meta's
   dialog with **their own** WhatsApp Business account.
3. Their number appears under **Numbers**, and messages to it raise tickets in
   **their** workspace, not yours.

Onboarding businesses with *no* role on your app requires Advanced Access from
App Review, whose prerequisite is verifying a registered company. See
`META_INTEGRATION_HANDBOOK.md`.

---

## Part 8 — Finish up (~5 min)

1. **Keep it awake.** uptimerobot.com → free account → **Add New Monitor** →
   HTTP(s) → `<API URL>/api/health` → every 5 minutes. The free API sleeps after
   15 minutes idle and takes ~50 s to wake.
2. **Update the README** with your real URLs (replace the old ones), commit and
   push — only after everything above actually works.
3. **Change the admin password.** The seeded one is in a public repo: sign in as
   admin → Profile → change password.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Build fails on `tsc: not found` | `NODE_ENV=production` dropped devDependencies. The Blueprint already uses `npm ci --include=dev`; if you created the service by hand, set that build command. |
| Health shows database not connected | Database and API are in **different regions** — the internal URL only resolves within one. Recreate from the Blueprint, which pins both to Singapore. |
| Health times out / API never boots | Free database expired (30 days). Create a new one, set `DATABASE_URL` to its **internal** URL, redeploy, re-seed. |
| Login fails with a network error | `CORS_ORIGIN` is not exactly your SITE URL. No trailing slash, `https`. |
| `No route matches POST /auth/login` | `VITE_API_BASE_URL` is missing `/api`. Fix it **and redeploy** Vercel. |
| Sidebar lacks Connect WhatsApp / Developers | Vercel built an old commit. Deployments → Redeploy latest. |
| WhatsApp: no reply arrives | In order: is `subscribed_apps` done (6d)? Is `account_update`+`messages` subscribed? Does `META_APP_SECRET` match the app? Check admin → Message log for the real error. |
| WhatsApp error code 190 | Access token expired — regenerate (6e). |
| WhatsApp error code 131030 | Recipient not in the allowed list — add the phone under API Setup → To. |
| "Connect with Facebook" greyed out | `META_APP_ID` or `META_ES_CONFIG_ID` not set on Render. |
| Meta dialog errors immediately | SITE URL not in **Allowed Domains for the JavaScript SDK**, or you are on `http`/localhost. |
| Graph API error code 200 | Expected without Advanced Access — you are acting on an account your app does not own. Only app testers/admins can onboard until App Review. |

---

## What you end up with

| | |
|---|---|
| Live site | your SITE URL |
| API | `<API URL>/api` |
| API docs | `<API URL>/api/docs` |
| Platform webhook | `<API URL>/api/webhooks/meta` |
| Database | Render PostgreSQL 16 + pgvector, Singapore |
| Cost | ₹0 — every service on its free tier |
