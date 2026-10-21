# Meta WhatsApp Integration — complete procedure, routing and readiness evidence

Everything needed to stand this up as a Tech Provider: what is already built,
what you must do in Meta's consoles, every key involved, and exactly where the
line is between "engineering complete" and "commercial approval pending".

**Sources** — [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers) ·
[Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/) ·
[Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/) ·
[WhatsApp App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review).
Verified 21 October 2026.

---

## 1. The headline: what is and is not possible

**You can build, run and fully demonstrate this today. You do not need Meta's
approval to prove the integration works.**

Meta's App Review page states it directly: *"Business apps are automatically
approved for Standard Access for all Permissions and Features available to the
Business app type, so you can test your app while you are in this access
level."*

| | Standard Access (automatic, today) | Advanced Access (after App Review) |
|---|---|---|
| Embedded Signup dialog opens | ✅ | ✅ |
| Permissions shown in the dialog | ✅ for anyone with an **admin / developer / tester** role on your app | ✅ for everyone |
| Onboard a business **you control** | ✅ | ✅ |
| Onboard a business **with no role on your app** | ❌ error code `200` | ✅ |
| Send/receive, route, templates, API | ✅ | ✅ |

So the honest sentence for your review is:

> *"The integration is complete and working. Businesses with a role on our Meta
> app can onboard through our Embedded Signup flow right now. The only
> remaining gate is Meta's App Review, which grants Advanced Access so that the
> general public can onboard — a commercial verification step, not an
> engineering one."*

That is a far stronger claim than "it's blocked", and it is accurate.

### Is App Review itself achievable?

| Requirement | Reality for this project |
|---|---|
| App Review submission | ✅ Free, **~24 hour** average turnaround |
| Two screen recordings | ✅ Recordable from this build today |
| Written justification per permission | ✅ Drafted in §6 below |
| **Business verification first** | ⚠️ The Tech Provider guide says *"Your business must be verified before you can start the app review process."* Needs a real registered entity |

In India a **sole proprietorship with a free Udyam/MSME registration** (online,
Aadhaar + PAN, usually same-day) is a genuine route to a verifiable business,
alongside a domain, a business email and a published privacy policy. It is not
impossible — it is simply a real-world company-registration task with real
obligations, not something to complete the night before a review.

**One important exemption:** Meta states that *"a Direct Developer using the API
for their own business doesn't need Advanced Access or App Review."* Your
original single-tenant helpdesk is exactly that case — it is fully legitimate
without any review at all.

---

## 2. Routing — how a message finds its business

This is the question to be ready for: *"If all your customers share one webhook,
how does a message know whose it is?"*

### The problem

Meta delivers **every** account's traffic to **one** callback URL per app. The
request does not say which of your customers it belongs to.

### The answer

```
                        ┌──────────────────────────────────────────┐
  Customer's phone      │              META                        │
        │               │  (routes by the number messaged)         │
        │ "my parcel…"  └──────────────────┬───────────────────────┘
        └──────────────────────────────────┘
                                           │  ONE webhook for all tenants
                                           ▼
                    POST /api/webhooks/meta
                                           │
             ┌─────────────────────────────┴─────────────────────────┐
             │ 1. Verify X-Hub-Signature-256 (HMAC-SHA256,           │
             │    platform app secret, constant-time)                │
             │    ✗ → 403, zero work done                            │
             └─────────────────────────────┬─────────────────────────┘
                                           ▼
             ┌─────────────────────────────┴─────────────────────────┐
             │ 2. value.metadata.phone_number_id                     │
             │       → SELECT … FROM wa_numbers                      │
             │         WHERE phone_number_id = $1   ← UNIQUE         │
             │       → tenant_id                                     │
             │    ✗ not found → 200, nothing created                 │
             │    ✗ tenant SUSPENDED → 200, dropped                  │
             └─────────────────────────────┬─────────────────────────┘
                                           ▼
             ┌─────────────────────────────┴─────────────────────────┐
             │ 3. Idempotency gate                                   │
             │    INSERT … ON CONFLICT (tenant_id,                   │
             │                          provider_message_id)         │
             │    DO NOTHING        ← replay stops here              │
             └─────────────────────────────┬─────────────────────────┘
                                           ▼
          ┌──────────────┬─────────────────┼──────────────────┬─────────────┐
          ▼              ▼                 ▼                  ▼             ▼
     contact book   usage meter   tenant's own webhook   helpdesk app   always 200
                                  (signed, retried)      (if enabled)
```

### Why `phone_number_id` is the right key

It is assigned by Meta, globally unique, immutable for the life of the number,
and present on every inbound payload. The schema declares it `UNIQUE`
platform-wide, so **a routing bug becomes a database constraint violation
rather than one business reading another's customer messages.**

### The three isolation rules multi-tenancy forced

| Rule | Why | Where |
|---|---|---|
| `users.whatsapp_number` unique **per tenant** | One person can be a customer of several businesses on the platform | `006_platform.sql` |
| `whatsapp_messages.provider_message_id` unique **per tenant** | One tenant's delivery must not deduplicate another's | `006_platform.sql` |
| Placeholder email `wa<number>.<slug>@whatsapp.local` | `users.email` is unique platform-wide, so the slug prevents collision | `whatsapp.service.ts` |

Proven by test: *"keeps the same phone number as two unrelated customers across
tenants"* and *"treats the same provider message id as distinct per tenant"*.

### Outbound routing

Reverse direction: `tenant_id` (+ optional `number_id`) → `wa_numbers` →
`wa_connections` → decrypt token → `POST /{phone_number_id}/messages`. A tenant
with no onboarded connection falls back to the deployment's own first-party
number, which is how the original helpdesk kept working.

---

## 3. Every key and secret, and where each one lives

### Platform-level — one set for the whole deployment

| Key | Where to get it | Where it goes | Exposed to browser? |
|---|---|---|---|
| `META_APP_ID` | App Dashboard → Settings → Basic | Render env | ✅ public by design |
| `META_APP_SECRET` | Same page → App Secret → Show | Render env | ❌ **never** |
| `META_ES_CONFIG_ID` | Facebook Login for Business → your configuration | Render env | ✅ public by design |
| `WHATSAPP_VERIFY_TOKEN` | You invent it | Render env **and** Meta webhook config — must match | ❌ |
| `PLATFORM_ENCRYPTION_KEY` | `openssl rand -hex 32` | Render env | ❌ |
| `PLATFORM_PUBLIC_URL` | Your API's public URL | Render env | ✅ |

The frontend receives only `META_APP_ID` and `META_ES_CONFIG_ID`, served from
`GET /api/platform/signup-config` — never baked into the bundle, so one build
works against any deployment.

### Per-tenant — created automatically during onboarding

| Credential | Origin | Storage |
|---|---|---|
| Business access token | Code exchange during Embedded Signup | **AES-256-GCM encrypted** in `wa_connections.access_token_encrypted`; logs show a 12-char fingerprint only |
| `waba_id` / `phone_number_id` | Returned by the signup dialog | Plain — they are identifiers, not secrets |

### Tenant-issued — created by the business in your console

| Credential | Purpose | Storage |
|---|---|---|
| API key `sdk_live_…` | Their software calls `/v1/*` | **SHA-256 hash only**; shown once |
| Webhook secret `whsec_…` | They verify our signature | Shown once |

---

## 4. The complete setup procedure

### Stage A — Meta app (15 min)

1. **developers.facebook.com → My Apps → Create App** → use case **Other** → type **Business**.
2. **Add product → WhatsApp → Set up.**
3. **App settings → Basic**: set app icon, category, and a **Privacy Policy URL** (required for review). Copy **App ID** and **App Secret**.

### Stage B — Facebook Login for Business (10 min) — *the step most people miss*

4. **Add product → Facebook Login for Business.**
5. **Settings → Client OAuth settings** — set **all** of these to Yes:
   - Client OAuth login
   - Web OAuth login
   - Enforce HTTPS
   - Embedded Browser OAuth Login
   - Use Strict Mode for redirect URIs
   - Login with the JavaScript SDK
6. Add your frontend domain to **Allowed Domains for the JavaScript SDK** *and* **Valid OAuth Redirect URIs**. **HTTPS only** — `localhost` will not work, so test against your Vercel URL.
7. **Configurations → Create** from the template *"WhatsApp Embedded Signup Configuration With 60 Expiration Token"*. Copy the **configuration ID** → `META_ES_CONFIG_ID`.

### Stage C — Webhooks (5 min)

8. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://<your-api>/api/webhooks/meta`
   - Verify token: your `WHATSAPP_VERIFY_TOKEN`
9. **Webhook fields → Manage** → subscribe to **`messages`** *and* **`account_update`**.
   `account_update` is required of a Tech Provider and is how you learn a
   customer's number was banned or restricted.

### Stage D — Deploy config (5 min)

10. Set the six platform variables from §3 on Render. Save; wait for Live.

### Stage E — Test the real flow without approval (15 min)

11. **App roles → Roles → Add People** → add your teammate as **Tester** (or Developer). They accept the invite.
12. Your teammate opens your live site → **Connect WhatsApp** → completes Meta's dialog with **their own** Facebook/WhatsApp Business account.
13. Their number appears under **Numbers**. A message to it raises a ticket **in their workspace, not yours.**

That is a genuine third-party business onboarding onto your platform. It is the
demo to record.

### Stage F — App Review, when a registered business exists

14. Complete **business verification** in Business Manager (documents).
15. **Use cases → Customize → WhatsApp → Tech Provider onboarding.**
16. Record the two videos (§6), write the justifications (§6), request Advanced
    access for `whatsapp_business_messaging` + `whatsapp_business_management`.
17. Submit. ~24 hours. Then any business can onboard.

---

## 5. Readiness evidence — every Meta requirement mapped to code and test

Hand this table to your faculty. It is the "I have done the work" proof.

| # | Meta requirement | Implemented in | Proven by |
|---|---|---|---|
| 1 | Embedded Signup **v4** (v2/v3 dead 15 Oct 2026) | `WhatsAppOnboarding.tsx` — `config_id`, `response_type:'code'`, `override_default_response_type`, `extras:{setup:{}}` | Manual — dialog opens |
| 2 | Handle every success variant | Same — `FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `FINISH_OBO_MIGRATION`, `FINISH_GRANT_ONLY_API_ACCESS` | Code review |
| 3 | Handle `CANCEL` / `ERROR` with Meta's reason | Same — surfaces `error_message` / `current_step` | Code review |
| 4 | Origin-check the window message | Same — exact-match on Facebook origins | Code review |
| 5 | Exchange code **server-side** (30 s TTL) | `graph.client.ts: exchangeCodeForToken` | Secret never in bundle |
| 6 | `POST /{phone_number_id}/register` | `graph.client.ts: registerPhoneNumber` | Already-registered treated as success |
| 7 | `POST /{waba_id}/subscribed_apps` | `graph.client.ts: subscribeApp` | Recorded as `subscribed_at`; fatal if it fails |
| 8 | Webhook verification handshake | `webhook.routes.ts` GET | Manual |
| 9 | `X-Hub-Signature-256` verification | `router.service.ts: verifyMetaSignature` | 3 tests |
| 10 | Multi-customer routing | `onboarding.service.ts: routeByPhoneNumberId` | 4 tests |
| 11 | Idempotent delivery | `UNIQUE (tenant_id, provider_message_id)` | 2 tests |
| 12 | Always 200 so Meta stops retrying | `webhook.routes.ts` | 3 tests |
| 13 | `account_update` (bans, restrictions) | `router.service.ts: applyAccountUpdate` | 2 tests |
| 14 | Delivery status callbacks | `router.service.ts: applyStatus` — never moves backwards | Code review |
| 15 | Tokens encrypted at rest | `crypto.ts` AES-256-GCM | 4 tests |
| 16 | Template create + status sync | `templates.routes.ts` | Code review |
| 17 | Opt-in before business-initiated messages | Broadcasts skip `opted_in = false` | Code review |
| 18 | Approved-template-only broadcasts | `templates.routes.ts` → 422 | Code review |
| 19 | Per-customer isolation | `tenant_id` on every owned table | 10 tests |
| 20 | WAAC / Messaging-account split tolerated | `waba_id` + `waac_id` columns | Schema |

**32 platform tests, 193 total, all passing against a real PostgreSQL.**

---

## 6. App Review submission — ready to paste

### `whatsapp_business_management`

> Our platform lets businesses connect their own WhatsApp Business Account
> through Embedded Signup. We use this permission to read the client's account
> and phone numbers so we can display them in their dashboard, to subscribe our
> app to their account's webhooks so their customer messages reach them, and to
> create and check the status of the message templates they author in our
> template manager. We access only the accounts a client has explicitly granted
> us during Embedded Signup.

*Video:* screen-record the Templates page creating a template and showing its
status change after sync.

### `whatsapp_business_messaging`

> We use this permission to send messages on behalf of businesses that have
> connected their WhatsApp Business Account to our platform. Their support
> agents reply to customers from our web console, and their own software can
> send messages through our REST API. We also register the client's phone
> number for Cloud API during onboarding. Every message is sent from the
> client's own number, to customers who have messaged them first or opted in.

*Video:* screen-record sending a message from the agent console or
`POST /v1/messages`, then the message arriving in WhatsApp.

**Rules that cause rejection:** one permission per video; screen recordings only
(no screenshots); request nothing you do not use; submit — drafts are not
reviewed.

---

## 7. What to say if asked "so is it done?"

> *"Engineering: done. A business can onboard through our Embedded Signup flow,
> their number is registered and subscribed, their messages route to their own
> workspace through a webhook shared with every other tenant, their agents can
> reply, and their own software can use our API with their own keys and signed
> webhooks. We prove the isolation with 32 automated tests.*
>
> *What is not done is commercial: Meta grants Advanced Access only after
> verifying a registered business. Until then the same flow works for anyone we
> add as a tester on our app — which is how we demonstrate it. That is a
> company-registration step, not a piece of software we failed to write."*
