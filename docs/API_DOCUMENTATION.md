# API Documentation

Base URL — local `http://localhost:4000/api`, production `https://<your-api>.onrender.com/api`

---

## Conventions

**Success**

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 } }
```

`meta` appears only on paginated endpoints.

**Failure**

```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "…", "details": [ { "field": "email", "message": "…" } ] } }
```

**Status codes**

| Code | Meaning |
|---|---|
| 200 / 201 / 204 | Success / created / deleted |
| 400 | Malformed request or failed validation |
| 401 | Missing, expired or invalid token |
| 403 | Authenticated but not permitted |
| 404 | Not found, or deliberately hidden from this user |
| 409 | Conflict (duplicate email, category in use) |
| 422 | Valid request that breaks a business rule (invalid lifecycle transition) |
| 429 | Rate limit exceeded |
| 500 / 503 | Server error / database unreachable |

**Authentication.** Send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes; the refresh token is an `httpOnly` cookie set at login, so refresh requests must be sent with credentials.

**Role column.** `—` public · `A` any authenticated user · `C` Customer · `AG` Agent · `AD` Admin

---

## Health

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health` | — | Process and database health |

```json
{ "success": true, "data": { "status": "ok", "database": "connected", "timestamp": "2026-08-17T16:47:33.510Z" } }
```

Returns `503` if the database is unreachable.

---

## Authentication — `/api/auth`

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create a Customer account |
| POST | `/auth/login` | — | Sign in |
| POST | `/auth/refresh` | — (cookie) | Exchange the refresh cookie for a new access token |
| POST | `/auth/logout` | — | Clear the refresh cookie |
| GET | `/auth/me` | A | Current user and unread notification count |

### POST /auth/register

```json
{ "fullName": "Rohan Menon", "email": "rohan@example.com", "password": "Password123", "phone": "+91 90000 00000" }
```

`fullName` 2–120 chars · `email` valid, unique · `password` ≥ 8 chars with a letter and a number · `phone` optional.

**201**

```json
{ "success": true, "data": { "user": { "id": "…", "email": "rohan@example.com", "fullName": "Rohan Menon", "role": "CUSTOMER", "isActive": true, "createdAt": "…" }, "accessToken": "eyJ…" } }
```

The role is always `CUSTOMER` — supplying a `role` field has no effect.

**Errors** — `400` validation · `409` email already registered · `429` too many attempts.

### POST /auth/login

```json
{ "email": "rohan@example.com", "password": "Password123" }
```

**200** — same shape as register, plus the `sd_refresh` cookie.

**Errors** — `401` `"Invalid email or password."` for both an unknown email and a wrong password, so the endpoint cannot be used to enumerate accounts · `403` account deactivated.

---

## User management — `/api/users`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/users/me` | A | Own profile |
| PATCH | `/users/me` | A | Update own name and phone |
| PATCH | `/users/me/password` | A | Change own password |
| GET | `/users/agents` | AG, AD | Active agents and admins, for assignment |
| GET | `/users` | AD | List users — `?role=&isActive=&q=&page=&limit=` |
| POST | `/users` | AD | Create a user with any role |
| GET | `/users/:id` | AD | One user, with ticket counts |
| PATCH | `/users/:id/role` | AD | Change a role |
| PATCH | `/users/:id/status` | AD | Activate or deactivate |

### PATCH /users/:id/role

```json
{ "role": "AGENT" }
```

**Errors** — `422` if an admin targets their own account (prevents lock-out) · `404` unknown user.

### PATCH /users/me/password

```json
{ "currentPassword": "Password123", "newPassword": "NewPassword456" }
```

**Errors** — `400` current password incorrect, or new password fails policy.

---

## Tickets — `/api/tickets`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/tickets` | A | List, role-scoped, filtered, paginated |
| POST | `/tickets` | C, AD | Create a ticket |
| GET | `/tickets/:id` | A | One ticket |
| PATCH | `/tickets/:id` | AG, AD | Update subject, priority, category |
| PATCH | `/tickets/:id/status` | A | Change status (lifecycle-validated) |
| PATCH | `/tickets/:id/assign` | AG, AD | Assign or unassign |
| DELETE | `/tickets/:id` | AD | Delete, cascading to messages and events |
| GET | `/tickets/:id/events` | A | Timeline |
| GET | `/tickets/:id/messages` | A | Conversation |
| POST | `/tickets/:id/messages` | A | Add a reply or internal note |

### GET /tickets

| Parameter | Values |
|---|---|
| `status` | `NEW` `OPEN` `IN_PROGRESS` `WAITING_FOR_CUSTOMER` `RESOLVED` `CLOSED` |
| `priority` | `LOW` `MEDIUM` `HIGH` `URGENT` |
| `sentiment` | `POSITIVE` `NEUTRAL` `NEGATIVE` |
| `categoryId` | UUID |
| `agentId` | UUID or `unassigned` |
| `customerId` | UUID (staff only; ignored for customers) |
| `from`, `to` | ISO 8601 datetimes |
| `q` | Free text — matches reference, subject, customer name and body |
| `page`, `limit` | Default 1 and 20; `limit` max 100 |
| `sort`, `order` | `createdAt` `updatedAt` `priority` `status` · `asc` `desc` |

**A Customer's results are always scoped to their own tickets**, regardless of the parameters supplied.

**200**

```json
{
  "success": true,
  "data": [
    {
      "id": "…", "reference": "SD-1024",
      "subject": "Payment deducted but order still pending",
      "description": "…",
      "priority": "URGENT", "status": "IN_PROGRESS", "sentiment": "NEGATIVE",
      "aiSummary": "Payment completed but order status remains pending.",
      "aiConfidence": 0.55, "aiClassifiedAt": "…",
      "createdAt": "…", "updatedAt": "…",
      "firstResponseAt": null, "resolvedAt": null, "closedAt": null,
      "customer": { "id": "…", "name": "Rohan Menon", "email": "rohan@example.com" },
      "agent":    { "id": "…", "name": "Priya Nair" },
      "category": { "id": "…", "name": "Billing" }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
}
```

### POST /tickets

```json
{ "subject": "Payment deducted but order still pending", "description": "My payment was deducted but…", "categoryId": null, "priority": "HIGH" }
```

`subject` 5–200 chars · `description` 10–5000 chars · `categoryId` and `priority` optional.

**201** — the ticket, with `status: "NEW"` and a generated `reference`.

Classification runs in the background after the response, so `sentiment` and `aiSummary` are typically `null` in this response and populated on the next read. This is deliberate: ticket creation never waits for, or fails because of, the AI service.

### PATCH /tickets/:id/status

```json
{ "status": "RESOLVED" }
```

Validated against the lifecycle table.

**Errors** — `422` invalid transition, e.g. `"A ticket cannot move from NEW to RESOLVED. Allowed: OPEN, IN_PROGRESS, CLOSED."` · `422` if an agent tries to reopen a closed ticket (admin only) · `422` if a customer attempts a staff-only transition.

Side effects: sets `resolvedAt` / `closedAt`, writes a `STATUS_CHANGED` event and an audit entry, and notifies the customer if someone else made the change.

### PATCH /tickets/:id/assign

```json
{ "agentId": "…" }
```

`null` unassigns. Assigning a `NEW` ticket also moves it to `OPEN`.

**Errors** — `422` target is a Customer or a deactivated account · `404` unknown agent.

### POST /tickets/:id/messages

```json
{ "body": "Thanks for reaching out — I am checking this now.", "isInternalNote": false, "aiAssisted": true }
```

`isInternalNote` is staff-only (`403` for a customer). `aiAssisted` records that the author started from an AI draft.

A public staff reply sets `firstResponseAt`, moves `NEW`/`OPEN` to `IN_PROGRESS`, and notifies the customer. A customer reply on a `WAITING_FOR_CUSTOMER` ticket returns it to `IN_PROGRESS`.

**Errors** — `422` the ticket is closed · `400` empty body.

### GET /tickets/:id/messages

Internal notes are filtered out in SQL for customers, so their content is never transmitted.

---

## Categories — `/api/categories`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/categories` | A | List — admins also see inactive ones, with ticket counts |
| POST | `/categories` | AD | Create |
| PATCH | `/categories/:id` | AD | Update name, description or active flag |
| DELETE | `/categories/:id` | AD | Delete |

**DELETE errors** — `409` if the category is used by any ticket: `"This category is used by 4 ticket(s). Deactivate it instead of deleting it."` Deleting would strip the category from historical tickets and distort the category report.

---

## Notifications — `/api/notifications`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/notifications` | A | Own notifications — `?unreadOnly=&page=&limit=` |
| GET | `/notifications/unread-count` | A | Badge count |
| PATCH | `/notifications/:id/read` | A | Mark one read |
| PATCH | `/notifications/read-all` | A | Mark all read |

All queries are scoped to the caller by `user_id`, so one user cannot read or modify another's notifications. `404` is returned for someone else's notification id.

---

## Dashboard — `/api/dashboard`

| Method | Path | Role |
|---|---|---|
| GET | `/dashboard/customer` | C |
| GET | `/dashboard/agent` | AG, AD |
| GET | `/dashboard/admin` | AD |

Every figure is aggregated from the database at request time. **No dashboard value is hard-coded anywhere in the codebase.**

### GET /dashboard/admin

```json
{
  "success": true,
  "data": {
    "metrics": { "totalTickets": 7, "openTickets": 7, "resolvedTickets": 0, "unassignedTickets": 5, "activeCustomers": 4, "activeAgents": 3, "averageResolutionHours": null },
    "byStatus":    [ { "label": "NEW", "count": 5 }, { "label": "IN_PROGRESS", "count": 2 } ],
    "byPriority":  [ { "label": "LOW", "count": 1 }, { "label": "HIGH", "count": 3 }, { "label": "URGENT", "count": 3 } ],
    "byCategory":  [ { "label": "Billing", "count": 3 } ],
    "bySentiment": [ { "label": "NEUTRAL", "count": 3 } ],
    "agentWorkload": [ { "name": "Priya Nair", "open": 2, "resolved": 0 } ],
    "trend": [ { "day": "2026-08-17", "count": 7 } ],
    "ai": { "ticketsClassified": 7, "suggestionsFromFallback": 8, "aiAssistedReplies": 0 }
  }
}
```

`averageResolutionHours` is `null` when nothing has been resolved — the UI shows a dash rather than a fabricated zero.

---

## Reports — `/api/reports`

All endpoints require Agent or Admin.

| Method | Path | Description |
|---|---|---|
| GET | `/reports/tickets-by-status` | Counts by status |
| GET | `/reports/tickets-by-priority` | Counts by priority |
| GET | `/reports/tickets-by-category` | Counts by category |
| GET | `/reports/sentiment` | Sentiment distribution |
| GET | `/reports/agent-workload` | Per agent: open, resolved, average resolution |
| GET | `/reports/trends?days=30` | Created vs resolved per day (7–365) |
| GET | `/reports/resolution-time` | Average resolution by category |
| GET | `/reports/export?format=csv` | CSV download |

The CSV export quotes every field per RFC 4180 and prefixes values beginning with `=`, `+`, `-` or `@` with an apostrophe, so a ticket subject cannot be executed as a formula by spreadsheet software.

---

## AI assistance — `/api/ai`

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/ai/tickets/:id/draft-reply` | AG, AD | Generate an editable draft |
| POST | `/ai/tickets/:id/summary` | AG, AD | Summarise the conversation |
| POST | `/ai/tickets/:id/resolution-steps` | AG, AD | Suggest troubleshooting steps |
| GET | `/ai/tickets/:id/suggestions` | AG, AD | Suggestions already generated |
| GET | `/ai/health` | AD | Which engine is active |

**These endpoints return suggestions only. None of them creates a customer-visible message.** A reply reaches a customer only when an agent posts to `/tickets/:id/messages`.

### POST /ai/tickets/:id/draft-reply

**200**

```json
{ "success": true, "data": { "draft": "Hi Rohan,\n\nThank you for contacting us about…", "model": "rule-based-fallback", "usedFallback": true, "notice": "Review and edit this draft before sending it to the customer." } }
```

`usedFallback: true` means the AI provider was unreachable and the deterministic rule-based engine produced the result. The interface displays this to the agent rather than hiding it.

### GET /ai/health

```json
{ "success": true, "data": { "configuredProvider": "fallback", "activeModel": "rule-based-fallback", "usingFallback": true, "suggestionsGenerated": 8, "suggestionsFromFallback": 8 } }
```

---

## Audit log — `/api/audit-logs`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/audit-logs` | AD | Privileged actions — `?action=&entityType=&page=&limit=` |

Recorded actions include `USER_REGISTERED`, `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DEACTIVATED`, `PASSWORD_CHANGED`, `TICKET_CREATED`, `TICKET_UPDATED`, `TICKET_STATUS_CHANGED`, `TICKET_ASSIGNED`, `TICKET_DELETED`, `CATEGORY_CREATED`, `CATEGORY_UPDATED`, `CATEGORY_DELETED`.

---

## Rate limiting

| Scope | Limit |
|---|---|
| `/auth/register`, `/auth/login` | 20 requests per 15 minutes per IP |
| All routes | 200 requests per minute per IP |

Exceeding either returns `429`. Both limiters are disabled when `NODE_ENV=test`.
