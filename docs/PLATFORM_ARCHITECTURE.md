# ServiceDesk Platform — WhatsApp Integration Architecture

How the system changed from *a business using WhatsApp* into *a platform other
businesses connect their own WhatsApp numbers to* — the model Twilio, AiSensy
and Gupshup operate.

---

## 1. What changed, in one paragraph

Before, one deployment owned one WhatsApp number, configured in environment
variables, and every ticket belonged to the same company. Now the deployment is
a **Tech Provider**: any number of businesses onboard their own WhatsApp
Business accounts through Meta's Embedded Signup, every row of data belongs to
exactly one of them, and the original helpdesk is simply the first app running
on the platform. The deployed single-tenant system did not break — migration
006 created a workspace and attributed all existing data to it.

---

## 2. The three roles, and why the distinction matters

| Role | Who | What they hold |
|---|---|---|
| **Meta** | WhatsApp Business Platform | The network, the numbers, the approval process |
| **Tech Provider** | *This platform* | One Meta app; onboards customers; routes their traffic; never owns their numbers |
| **Business customer (tenant)** | Acme Retail, Globex, … | Their own WhatsApp Business Account and number; their own data |

The critical consequence: **we hold access tokens that act as somebody else's
business**. That single fact drives the encryption, the isolation tests and the
audit log.

---

## 3. Onboarding — Embedded Signup v4

> Meta deprecated Embedded Signup v2 and v3 on **15 October 2026**. This
> integration targets **v4**. Guides published before that date describe a flow
> that no longer exists.

```
Browser                         This platform                  Meta
   │                                  │                          │
   │  click "Connect WhatsApp"        │                          │
   │─────────────────────────────────>│                          │
   │  GET /platform/signup-config     │                          │
   │<─────────────────────────────────│  app_id, config_id       │
   │                                                             │
   │  FB.login({config_id, response_type:'code'})                │
   │────────────────────────────────────────────────────────────>│
   │                                        (customer authorises)│
   │  window message: WA_EMBEDDED_SIGNUP FINISH                  │
   │     { waba_id, phone_number_id }                            │
   │  callback: { code }                                         │
   │<────────────────────────────────────────────────────────────│
   │                                  │                          │
   │  POST /platform/connections/embedded-signup                 │
   │     { code, waba_id, phone_number_id }                      │
   │─────────────────────────────────>│                          │
   │                                  │ 1. exchange code→token   │
   │                                  │─────────────────────────>│
   │                                  │ 2. POST /{num}/register  │
   │                                  │─────────────────────────>│
   │                                  │ 3. POST /{waba}/subscribed_apps
   │                                  │─────────────────────────>│
   │                                  │ 4. read back account+numbers
   │                                  │─────────────────────────>│
   │<─────────────────────────────────│  connection ACTIVE       │
```

### Why each server step exists

| Step | Why it cannot be skipped |
|---|---|
| **Exchange code → token** | Needs the app secret, which must never be in the browser. The browser only ever holds a short-lived code. |
| **Register the number** | Activates it for Cloud API. Already-registered numbers (coexistence onboarding) return an error that is treated as success, not failure. |
| **`subscribed_apps`** | **The step Meta's dashboard does not perform.** Without it nothing is ever delivered, and nothing in the UI says so. This integration failed exactly here during development; it is now explicit, fatal on failure, and recorded as `subscribed_at`. |
| **Read back** | The console shows what Meta actually reports, not what we hoped happened. |

### The account-model split

Meta is splitting the WABA into a **WhatsApp account (WAAC)** — phone numbers
and business identity — and a **Messaging account** — templates, billing and
webhook subscriptions. Existing `waba_id` values now denote the Messaging
account. The schema stores both (`waba_id`, `waac_id`) so the change does not
require a migration later.

---

## 4. Routing — one webhook, many businesses

Meta delivers **all** of an app's traffic to a single callback URL, no matter
how many customer accounts are subscribed. The tenant is therefore never stated
by the request; it is derived.

```
Meta ──POST /api/webhooks/meta──> verify X-Hub-Signature-256 (app secret)
                                        │ fails → 403, no work done
                                        ▼
                      value.metadata.phone_number_id
                                        │
                           wa_numbers.phone_number_id  (UNIQUE)
                                        │
                                   tenant_id
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                contact book     usage metering   tenant's webhook
                                                         │
                                            helpdesk app (if enabled)
```

**`wa_numbers.phone_number_id` is `UNIQUE` platform-wide.** That constraint is
the thing standing between correct routing and one business reading another's
customer messages: a routing bug becomes a constraint violation rather than a
data leak.

Three deliberate behaviours:

- **Always 200 after a valid signature.** Meta retries any other status, so one
  tenant's handler failing must not cause redelivery storms for everyone.
- **A number we do not serve is answered normally.** That is a routine
  consequence of a disconnect, not a fault.
- **A suspended tenant's traffic is dropped**, not queued.

---

## 5. Data model

Twelve tenant-scoped tables were added or amended in migration 006.

| Table | Purpose | Notable constraint |
|---|---|---|
| `tenants` | One business | `slug` URL-safe; `helpdesk_enabled` switches the built-in app off |
| `wa_connections` | An onboarded WABA | Token **AES-256-GCM encrypted**; `waba_id` unique |
| `wa_numbers` | Routing table | `phone_number_id` **unique platform-wide**; one default per tenant |
| `api_keys` | Machine auth | Only the SHA-256 hash stored; prefix kept for display |
| `webhook_endpoints` / `webhook_deliveries` | Outbound events | `CHECK` keeps `delivered_at` consistent with status |
| `message_templates` | Meta templates | Mirrors Meta's status vocabulary, not our own |
| `contacts` | Per-tenant contact book | `last_inbound_at` decides the 24-hour window |
| `broadcasts` / `broadcast_recipients` | Campaigns | Unique per `(broadcast, number)` |
| `usage_events` | Metering | Append-only |

### What multi-tenancy actually forced to change

| Was | Now | Why |
|---|---|---|
| `categories.name` unique | unique per `(tenant_id, name)` | Two businesses may both have "Billing" |
| `users.whatsapp_number` unique | unique per `(tenant_id, …)` | One person can be a customer of several businesses |
| `whatsapp_messages.provider_message_id` unique | unique per `(tenant_id, …)` | One tenant's delivery must not silence another's |
| Placeholder email `wa<number>@…` | `wa<number>.<slug>@…` | `users.email` is unique platform-wide |

---

## 6. Security

| Concern | Mechanism |
|---|---|
| Customer access tokens | AES-256-GCM at rest, keyed by `PLATFORM_ENCRYPTION_KEY`; production refuses to start without it. Logs carry a 12-character fingerprint, never the token. |
| Forged inbound webhooks | HMAC-SHA256 over the raw body with the app secret, constant-time compare, checked before any work. |
| Outbound webhook spoofing/replay | Signature covers `timestamp.body`; receivers reject anything older than five minutes. |
| API keys | SHA-256 hash stored; shown once; revoked not deleted so the audit log stays explicable. |
| Session riding the public API | `/v1` accepts API keys only — a cookie is refused, so a malicious page cannot drive a tenant's messaging. |
| Cross-tenant access | Every query scoped by `tenant_id`; the tenant is never taken from client input. |

---

## 7. The two ways in

| | Console API | Public API |
|---|---|---|
| Path | `/api/platform/*` | `/v1/*` |
| Auth | Session (JWT + refresh cookie) | API key |
| Audience | A person configuring their integration | A tenant's own software |
| Stability | Changes with the UI | A published contract |
| Rate limit | Shared app limit | 120/min **per key** |

`POST /v1/messages` honours an `Idempotency-Key` header: the same key within a
tenant returns the original result instead of messaging the customer twice.

---

## 8. Templates and broadcasts

WhatsApp only lets a business open a conversation with an **approved template**,
so the two features are inseparable. The platform enforces both Meta rules
rather than trusting the caller:

- A broadcast using a non-`APPROVED` template is refused with 422.
- Contacts without `opted_in` are skipped.
- Sends are sequential with a delay, because a burst is the fastest way to get
  a number rate-limited.

Approval is asynchronous and not reliably pushed to a webhook, so
`POST /api/templates/sync` pulls the authoritative status from Meta. Local rows
are updated from Meta, never the reverse.

---

## 9. Testing

190 automated tests against a real PostgreSQL, 29 of them specific to the
platform. The ones that matter commercially:

| Test | What it prevents |
|---|---|
| Same phone number, two tenants → two unrelated accounts | Cross-tenant identity collision |
| Same `provider_message_id`, two tenants → both stored | One tenant silencing another |
| Replay within one tenant → one ticket | Duplicate tickets from provider retries |
| Unsigned delivery → 403, nothing created | Forged messages |
| Suspended tenant → dropped | Billing/abuse controls having no effect |
| Tenant B listing/revoking tenant A's keys → 404 | Cross-tenant key access |
| Session cookie on `/v1` → 401 | CSRF-driven messaging |
| Webhook retries with growing delay, then FAILED | Infinite retry against a dead endpoint |

---

## 10. Honest limitations

Stated plainly, because they will be asked about.

- **Meta Tech Provider approval is not held.** Approval requires verifying a
  real registered business (documents, address, contactable phone). The
  integration meets Meta's technical requirements; the commercial status is a
  separate matter. See `META_APPROVAL_PATH.md`.
- **Without Advanced access**, the permissions do not appear in the Embedded
  Signup dialog, so only app admins/developers/testers can complete it. That is
  enough to demonstrate the flow, not to onboard the public.
- **Webhook delivery runs in-process.** Durable, retried and safe across
  replicas via `FOR UPDATE SKIP LOCKED`, but a dedicated queue would be the
  next step at real volume.
- **Broadcasts send sequentially** in the API process. Correct and
  rate-limit-friendly; not suited to tens of thousands of recipients.
- **No per-tenant billing.** `usage_events` meters everything needed for it;
  nothing prices it.
- **Token refresh is not implemented.** Business tokens from Embedded Signup are
  long-lived, but a revoked one requires re-onboarding rather than refreshing.
