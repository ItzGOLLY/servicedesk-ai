# Meta Tech Provider — approval path and readiness

What Meta actually requires to run a platform like this commercially, what this
project has done, and what it honestly cannot do.

**Sources** — [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers),
[Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/),
[WhatsApp App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review).
Checked 19–21 October 2026.

---

## 1. The honest headline

**This project does not hold Tech Provider approval, and cannot realistically
obtain it.**

Approval requires Meta to verify a *real registered business* — legal name,
registered address, a phone number Meta calls, a matching website, and
supporting documents if the business is not already on record. A student
project has no such entity.

What the project *has* done is build the integration to the standard Meta
requires, so that everything except the commercial verification is in place.
That distinction is stated wherever this work is presented.

---

## 2. The required sequence

Order matters: **business verification must complete before App Review opens.**

| # | Step | Where | Blocking for us? |
|---|---|---|---|
| 1 | Create a Meta app with the WhatsApp use case, attached to a business portfolio | App Dashboard | ✅ Done — app `ServiceDesk AI` |
| 2 | Open **Use cases → Customize → WhatsApp → Tech Provider onboarding** | App Dashboard | ✅ Reachable |
| 3 | **Verify the business**: name, address, phone, email, website, plus documents | Business Manager | ❌ **Blocked — no registered business** |
| 4 | App settings: icon, privacy policy URL, category | App Dashboard | ✅ Can be completed |
| 5 | Record two demonstration videos (below) | — | ✅ Recordable against test assets |
| 6 | Request **Advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management` | App Review | ❌ Depends on step 3 |
| 7 | Submit; typical turnaround ≈ 24 hours | App Review | ❌ Depends on step 3 |

### The two videos Meta asks for

1. A message **created and sent from your app**, received in the WhatsApp client.
2. Your app being **used to create a message template**.

Both are demonstrable with this build: the first from the agent reply or
`POST /v1/messages`, the second from the Templates page. Meta also accepts
screen recordings of the API Setup cURL and WhatsApp Manager as an alternative.

---

## 3. What Advanced access actually changes

| | Standard access (now) | Advanced access (after review) |
|---|---|---|
| Who can complete Embedded Signup | App admins, developers, testers only | Any business |
| Permissions shown in the dialog | Only granted ones appear | All requested ones |
| Managing accounts you don't own | **Error code 200** | Works |
| Onboarding limit | — | 10 → 200 new customers per rolling 7 days once verification + review + Access Verification are complete |

**Error code 200 is the symptom to recognise.** Meta reports it as
"Permissions error", which does not say what is wrong. The platform translates
it, in `onboarding.service.ts`:

> *Meta refused the call with code 200. This normally means the app does not yet
> have Advanced access to `whatsapp_business_management`, which App Review must
> grant before customer accounts can be managed.*

---

## 4. Technical readiness checklist

Everything Meta requires of the *integration*, and where it is implemented.

| Requirement | Status | Where |
|---|---|---|
| Embedded Signup **v4** (v2/v3 dead since 15 Oct 2026) | ✅ | `WhatsAppOnboarding.tsx` — `config_id`, `response_type: 'code'`, `sessionInfoVersion: '3'` |
| Server-side code exchange (app secret never in the browser) | ✅ | `graph.client.ts: exchangeCodeForToken` |
| `POST /{phone_number_id}/register` | ✅ | `graph.client.ts: registerPhoneNumber`; already-registered treated as success |
| `POST /{waba_id}/subscribed_apps` | ✅ | `graph.client.ts: subscribeApp`; recorded as `subscribed_at` |
| Webhook signature verification (`X-Hub-Signature-256`) | ✅ | `router.service.ts: verifyMetaSignature`, constant-time |
| Webhook verification handshake (`hub.challenge`) | ✅ | `webhook.routes.ts` GET handler |
| Multi-customer routing by `phone_number_id` | ✅ | `onboarding.service.ts: routeByPhoneNumberId` |
| Idempotent delivery handling | ✅ | `UNIQUE (tenant_id, provider_message_id)` |
| Prompt 200 so Meta does not retry | ✅ | `webhook.routes.ts` |
| Token storage encrypted at rest | ✅ | `crypto.ts` AES-256-GCM |
| Template creation and status sync | ✅ | `templates.routes.ts` |
| Opt-in enforced before business-initiated messages | ✅ | Broadcasts skip `opted_in = false` |
| Per-customer isolation | ✅ | 29 platform tests |
| WAAC / Messaging account split tolerated | ✅ | `waba_id` + `waac_id` columns |

---

## 5. Configuration needed to run it live

| Variable | Where it comes from |
|---|---|
| `META_APP_ID` | App Dashboard → Settings → Basic |
| `META_APP_SECRET` | Same page → App Secret |
| `META_ES_CONFIG_ID` | Facebook Login for Business → configuration id |
| `WHATSAPP_VERIFY_TOKEN` | Invented; entered in both places |
| `PLATFORM_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `PLATFORM_PUBLIC_URL` | This API's public base URL |

Callback URL to register with Meta:

```
https://<your-api-host>/api/webhooks/meta
```

Subscribe the app to the **`messages`** webhook field. Then, for each customer
account, confirm the subscription exists — the dashboard does not do this:

```bash
curl -X POST "https://graph.facebook.com/v22.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <BUSINESS_TOKEN>"
```

---

## 6. What can be demonstrated without approval

| Demonstrable | How |
|---|---|
| The full Embedded Signup dialog | As an app admin/developer/tester on a test business you own |
| Code → token → register → subscribe, server-side | Live, against your own test WABA |
| Multi-tenant routing | Two workspaces, two numbers; or the simulate endpoint; or the 29 tests |
| Tenant API + signed webhooks | Fully — no Meta dependency |
| Templates | Creation and sync against a test WABA |
| Broadcasts | Against test recipients within the 24-hour window |

**Not demonstrable:** onboarding a business you do not control, and the
200-customers-per-week tier. Both require approval, and approval requires a
registered business.

---

## 7. If this were taken commercially

In order:

1. Register a legal entity; get a domain, a business email and a published
   privacy policy.
2. Complete Meta business verification (steps 3–4 above).
3. Record the two videos and submit for Advanced access.
4. Complete Access Verification to raise the onboarding limit to 200/week.
5. Add billing — `usage_events` already meters it; nothing prices it yet.
6. Move webhook delivery and broadcasts onto a real queue.
7. Decide between Tech Provider (customers pay Meta directly) and Solution
   Partner (a shared credit line, higher commercial commitment).
