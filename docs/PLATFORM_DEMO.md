# Platform demo — showing it is a platform, not an app

The single thing a reviewer needs to see: **two businesses, one webhook, no
leakage between them.** Everything below was run against the local stack and
produced the output shown.

---

## 0. Start the stack

```bash
# PostgreSQL 16 must have pgvector available
cd backend && npm run migrate && npm run seed && npm run dev
cd frontend && npm run dev
```

Sign in as `admin@servicedesk.ai` / `Admin@12345`.

---

## 1. Show the onboarding page — the thing that makes it a platform

**Admin → Connect WhatsApp**

Say: *"A business clicks this, authorises inside Meta's own dialog, and their
number is live on our platform. We never see their password, and their access
token never reaches the browser — the browser only carries a short-lived code
that our server exchanges."*

If `META_APP_ID` is unset the page says so plainly instead of failing. That is
the honest state, and it is worth showing rather than hiding.

---

## 2. Create a second business

```sql
INSERT INTO tenants (name, slug) VALUES ('Globex Retail','globex');

INSERT INTO wa_connections (tenant_id, waba_id, access_token_encrypted, token_fingerprint, status, subscribed_at)
SELECT id, 'waba-'||slug, '', 'demofingerpr', 'ACTIVE', NOW() FROM tenants;

INSERT INTO wa_numbers (tenant_id, connection_id, phone_number_id, display_number, registered, is_default)
SELECT t.id, c.id, 'pn-'||t.slug, '+1555000'||row_number() OVER (ORDER BY t.created_at), TRUE, TRUE
  FROM tenants t JOIN wa_connections c ON c.tenant_id = t.id;
```

Two businesses now exist, each owning one `phone_number_id`.

---

## 3. Send the same customer to both, through the one webhook

`scripts/platform-demo.sh` posts correctly signed Meta payloads. The important
part is that **every request goes to the same URL** — `/api/webhooks/meta` —
and only the `phone_number_id` differs.

Observed:

```
ACME  -> 200        # message on pn-demo
GLOBEX-> 200        # same person, message on pn-globex
replay-> 200        # byte-identical replay of the first
unknown number -> 200   # a number we do not serve
unsigned -> 403     # no signature
```

---

## 4. Show what landed

```sql
SELECT t.slug AS tenant, tk.reference, left(tk.subject,38), tk.channel
  FROM tickets tk JOIN tenants t ON t.id = tk.tenant_id
 WHERE tk.channel = 'WHATSAPP' ORDER BY t.slug;
```

```
 tenant | reference |                subject                 | channel
--------+-----------+----------------------------------------+----------
 demo   | SD-1009   | My payment was taken twice this mornin  | WHATSAPP
 globex | SD-1010   | My parcel never arrived at all.         | WHATSAPP
```

Each message became a ticket **for the business whose number it arrived on**.

```sql
SELECT t.slug, u.email, u.whatsapp_number
  FROM users u JOIN tenants t ON t.id = u.tenant_id
 WHERE u.whatsapp_number = '+919000012345';
```

```
 tenant |                email                 | whatsapp_number
--------+--------------------------------------+-----------------
 demo   | wa919000012345.demo@whatsapp.local   | +919000012345
 globex | wa919000012345.globex@whatsapp.local | +919000012345
```

**The same human is two unrelated customers.** Acme cannot see that this person
also contacted Globex. That is the whole point.

Replay check:

```sql
SELECT count(*) FROM whatsapp_messages WHERE provider_message_id = 'wamid.DEMO1';
-- 1
```

The byte-identical replay created nothing: provider retries cannot duplicate
tickets.

---

## 5. The Twilio half — API keys and webhooks

**Admin → Developers → Create key.** The key is shown once, with the reason
stated: only a hash is stored.

```bash
curl -s http://localhost:4000/v1/me -H "Authorization: Bearer sdk_test_…"
```

```json
{ "success": true,
  "data": { "tenant": { "name": "ServiceDesk Demo", "slug": "demo", "status": "ACTIVE" },
            "numbers": 1 } }
```

Then show the three refusals that matter:

| Try | Result |
|---|---|
| A wrong key | `401` |
| A revoked key | `401` |
| A **session cookie** instead of a key | `401` — the public API is keys only, so a malicious page cannot drive a tenant's messaging |

Add a webhook endpoint and show the delivery log: attempts, response codes and
the error text when an endpoint is down.

---

## 6. Points worth making out loud

- **One webhook, many businesses.** Meta sends every account's traffic to one
  URL; the tenant is derived from the number, and `wa_numbers.phone_number_id`
  is `UNIQUE` platform-wide so a routing bug becomes a constraint violation
  rather than a data leak.
- **`subscribed_apps` is the step everyone misses.** Meta's dashboard does not
  do it; without it nothing is delivered and nothing says why. We call it
  explicitly and record `subscribed_at`.
- **Tokens are encrypted at rest** with AES-256-GCM; logs carry a 12-character
  fingerprint, never the token.
- **Embedded Signup v4** — v2 and v3 were deprecated on 15 October 2026.
- **Approval is a business problem, not a technical one.** Tech Provider status
  needs a verified registered company. The integration meets Meta's technical
  bar; `META_APPROVAL_PATH.md` sets out exactly what remains and why.

---

## 7. Tests as evidence

```bash
cd backend && npm test
# 191 passed (191)
```

30 of those are platform-specific. The ones to name if asked how isolation is
guaranteed:

- same number + two tenants → two unrelated accounts
- same `provider_message_id` + two tenants → both stored, neither silenced
- tenant B listing or revoking tenant A's keys → `404`
- unsigned webhook → `403`, nothing created
- suspended tenant → traffic dropped
- webhook retries back off, then stop at `FAILED`
