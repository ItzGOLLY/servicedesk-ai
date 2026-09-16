# Testing

## How to run

```bash
cd backend
cp .env.example .env.test        # point DATABASE_URL at a dedicated test database
npm test
```

The suite runs against a **real PostgreSQL database with pgvector**, not a mock.
Start it with `docker compose up -d postgres` — the knowledge base needs the
vector extension, so a plain `postgres:16` will fail migration 003. It applies the same migration files the production database uses, so a schema constraint that would fail in production also fails here.

`AI_PROVIDER` is forced to `fallback` in `tests/setup.ts`, so tests never make a network call and results are deterministic.

Tests run single-threaded because they share one database — parallel files would truncate each other's fixtures.

---

## Last recorded run

| | |
|---|---|
| Date | 17 August 2026 |
| Environment | Node.js 20, PostgreSQL 16 (local), `AI_PROVIDER=fallback` |
| Command | `npm test` |
| Test files | 6 passed (6) |
| **Tests** | **158 passed (158), 0 failed** |
| Duration | ~108 s |

```
 Test Files  6 passed (6)
      Tests  158 passed (158)
```

Also verified in **GitHub Actions CI** against the same `pgvector/pgvector:pg16`
image used by Docker Compose, so CI cannot pass on a database that differs from
local development.

Four defects were found and fixed by this suite during development:

1. **Rate limiter throttled the suite.** The 20-per-15-minute login limit is correct for production but caused 51 failures in a run that logs in far more often than a human. Fixed by skipping both limiters when `NODE_ENV=test`.
2. **A test asserted an exact suggestion count.** The create route classifies in the background, so the count depended on timing. The assertion was rewritten to check that *every* stored suggestion is a correctly flagged classification, which is the property that actually matters.
3. **The WhatsApp truncation could exceed the provider limit.** `truncate` reserved fewer characters than its own suffix needed, producing a 4097-character message where the maximum is 4096. WhatsApp rejects an over-length message outright, so this would have silently dropped long agent replies. The suffix length is now subtracted from the budget rather than assumed.
4. **The WhatsApp test file closed the shared connection pool twice**, breaking a later suite. The teardown was hoisted to a single file-level hook.

A further four were raised in code review and fixed:

5. **`NEW` was documented but not implemented** — it replied with the help text and behaved identically to `HELP`. It now accepts `NEW <description>` and raises a separate ticket; bare `NEW` asks for a description.
6. **A refused `CLOSE` sent a status-change message** reading "is now open", implying something had happened and omitting the reason. A dedicated template now returns the reason.
7. **The admin message log showed the empty state on a failed fetch**, telling an admin there were no messages when the log was merely unavailable.
8. **The simulator logged full customer numbers and message bodies.** Because the simulator is the default provider, this would have written customer data into application logs in any deployment without credentials. The number is now masked and the body omitted outside development.

---

## Test case results

Legend — **P** pass · **F** fail

### 1. Authentication — `tests/auth.test.ts` (13 cases)

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| A-01 | Register with valid details | 201, user created, token returned | As expected | P |
| A-02 | Register supplying `role: ADMIN` | Role forced to `CUSTOMER` | Role was `CUSTOMER` | P |
| A-03 | Inspect stored password | bcrypt hash, `$2` prefix, not plaintext | Hash stored | P |
| A-04 | Register with password `abc` | 400 with a `password` field error | As expected | P |
| A-05 | Register a duplicate email | 409 CONFLICT | As expected | P |
| A-06 | Log in with correct credentials | 200, access token | As expected | P |
| A-07 | Log in with wrong password | 401 "Invalid email or password." | As expected | P |
| A-08 | Compare unknown-email and wrong-password responses | Identical status and message | Identical | P |
| A-09 | Log in to a deactivated account | 403 | As expected | P |
| A-10 | Call `/auth/me` with no token | 401 UNAUTHORIZED | As expected | P |
| A-11 | Call `/auth/me` with a forged token | 401 | As expected | P |
| A-12 | Call `/auth/me` with a valid token | 200, correct user and role | As expected | P |
| A-13 | Use a valid token after the account is deactivated | 403 — takes effect immediately | As expected | P |

### 2. Authorization / RBAC — `tests/authorization.test.ts` (26 cases)

Every case calls the API directly with a valid token for the wrong role, demonstrating that access control does not depend on the user interface.

**A customer cannot:**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| R-01 | List all users | 403 | As expected | P |
| R-02 | Create a user | 403 | As expected | P |
| R-03 | Change anyone's role | 403 | As expected | P |
| R-04 | Read the audit log | 403 | As expected | P |
| R-05 | Create a category | 403 | As expected | P |
| R-06 | Open the admin dashboard | 403 | As expected | P |
| R-07 | Read reports | 403 | As expected | P |
| R-08 | Read another customer's ticket | 404 (existence not disclosed) | As expected | P |
| R-09 | See another customer's ticket in a list | Only own ticket returned | 1 of 2 returned | P |
| R-10 | Post a message on another customer's ticket | 404 | As expected | P |
| R-11 | Add an internal note on their own ticket | 403 | As expected | P |
| R-12 | See staff internal notes on their own ticket | Note filtered out | 1 of 2 messages returned | P |
| R-13 | Assign a ticket | 403 | As expected | P |
| R-14 | Delete a ticket | 403 | As expected | P |
| R-15 | Use the AI endpoints | 403 | As expected | P |

**An agent cannot:**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| R-16 | List all users | 403 | As expected | P |
| R-17 | Change a role | 403 | As expected | P |
| R-18 | Create a category | 403 | As expected | P |
| R-19 | Delete a ticket | 403 | As expected | P |
| R-20 | Read the audit log | 403 | As expected | P |
| R-21 | Open the admin dashboard | 403 | As expected | P |
| R-22 | *(positive)* See every customer's ticket | Both tickets returned | As expected | P |

**An admin:**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| R-23 | Can list users | 200 | As expected | P |
| R-24 | Can read the audit log | 200 | As expected | P |
| R-25 | Cannot remove their own admin role | 422 — prevents lock-out | As expected | P |
| R-26 | Cannot deactivate their own account | 422 | As expected | P |

### 3. Tickets — `tests/tickets.test.ts` (33 cases)

**Create**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-01 | Create a valid ticket | 201, status `NEW`, reference `SD-nnnn` | As expected | P |
| T-02 | Create with a 5-character description | 400 | As expected | P |
| T-03 | Timeline after creation | A `CREATED` event with `to = NEW` | As expected | P |
| T-04 | Agent attempts to raise a ticket | 403 | As expected | P |

**Read and update**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-05 | Owner reads their ticket | 200, correct reference | As expected | P |
| T-06 | Read a non-existent UUID | 404 | As expected | P |
| T-07 | Read a malformed id | 400 | As expected | P |
| T-08 | Agent changes priority | 200, and a `PRIORITY_CHANGED` event | As expected | P |
| T-09 | Agent sets category | 200, category reflected | As expected | P |

**Delete**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-10 | Admin deletes a ticket | 204, then 404 on re-read | As expected | P |
| T-11 | Delete cascades to messages | No orphaned message rows | 0 rows remained | P |

**Assignment**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-12 | Assign a `NEW` ticket | 200, agent set, status becomes `OPEN` | As expected | P |
| T-13 | Assignment notifies the agent | A `TICKET_ASSIGNED` notification exists | As expected | P |
| T-14 | Assign to a customer | 422 | As expected | P |

**Status transitions**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-15 | `NEW → OPEN` | 200 | As expected | P |
| T-16 | `NEW → RESOLVED` | 422 naming permitted transitions | As expected | P |
| T-17 | Resolve a ticket | `resolvedAt` set | As expected | P |
| T-18 | Reopen a resolved ticket | `resolvedAt` cleared (DB constraint) | As expected | P |
| T-19 | Customer sets `IN_PROGRESS` | 422 | As expected | P |
| T-20 | Agent reopens a closed ticket | 422 mentioning administrator | As expected | P |
| T-21 | Admin reopens a closed ticket | 200, status `OPEN` | As expected | P |
| T-22 | Status value `BANANA` | 400 | As expected | P |

**Messages**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-23 | Staff reply | 201, `firstResponseAt` set, status `IN_PROGRESS` | As expected | P |
| T-24 | Whitespace-only message | 400 | As expected | P |
| T-25 | Reply on a closed ticket | 422 | As expected | P |
| T-26 | Customer replies to a waiting ticket | Status returns to `IN_PROGRESS` | As expected | P |

**Search, filter and pagination**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| T-27 | Filter `?status=NEW` | Only `NEW` tickets | As expected | P |
| T-28 | Search `?q=refund` (body keyword) | The refund ticket only | 1 result | P |
| T-29 | Search by ticket reference | Exactly that ticket | 1 result | P |
| T-30 | Search by customer name | All that customer's tickets | 3 results | P |
| T-31 | Filter `?agentId=unassigned` | Only unassigned tickets | As expected | P |
| T-32 | `?page=1&limit=2` with 3 tickets | 2 rows, `total: 3`, `totalPages: 2` | As expected | P |
| T-33 | `?limit=9999` | 400 | As expected | P |

### 4. Lifecycle rules and AI — `tests/ai.test.ts` (20 cases)

**Lifecycle unit tests (no database)**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| L-01 | Every transition in the table is permitted | All allowed | As expected | P |
| L-02 | Transitions absent from the table are refused | `NEW→RESOLVED`, `CLOSED→RESOLVED` refused | As expected | P |
| L-03 | A no-op transition is refused | `OPEN→OPEN` refused | As expected | P |
| L-04 | Reopening a closed ticket is admin-only | Agent refused, admin allowed | As expected | P |
| L-05 | Customer transitions are restricted | Only close/reopen from `RESOLVED` | As expected | P |

**Fallback classifier unit tests**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| AI-01 | Payment complaint containing "urgent" | Category `Billing`, priority `URGENT` | As expected | P |
| AI-02 | Password reset request | Category `Account` | As expected | P |
| AI-03 | Angry message | Sentiment `NEGATIVE` | As expected | P |
| AI-04 | Categories restricted to a custom list | Proposes only a configured category | As expected | P |
| AI-05 | Same input classified twice | Identical output (deterministic) | Identical | P |
| AI-06 | Draft reply | Addresses the customer, signs off as Customer Support | As expected | P |
| AI-07 | Billing resolution steps | Billing-specific playbook returned | As expected | P |

**AI integration and graceful degradation**

| # | Test case | Expected | Actual | Status |
|---|---|---|---|---|
| AI-08 | Classify a new ticket | Sentiment, summary and category stored | As expected | P |
| AI-09 | Suggestion record | Kind `CLASSIFICATION`, `used_fallback = true`, model recorded | As expected | P |
| AI-10 | Customer chose a category that contradicts the text | Customer's choice preserved | `Account` kept over `Billing` | P |
| AI-11 | **Classification fails entirely** | Ticket still created (201); `classifyAndStore` swallows the error | Ticket created, no throw | P |
| AI-12 | Generate a draft reply | Draft returned with review notice, **and no message created** | 0 messages existed | P |
| AI-13 | Agent edits the draft and sends | Message stored with the edit, flagged `aiAssisted` | As expected | P |
| AI-14 | Generate a summary | Summary returned and stored, `usedFallback: true` | As expected | P |
| AI-15 | Admin checks AI health | Reports the active engine | `rule-based-fallback` | P |

---

## Coverage against the required areas

| Required area | Covered by |
|---|---|
| Registration | A-01 – A-05 |
| Login | A-06, A-07 |
| Invalid login | A-07, A-08, A-09 |
| Unauthorised access | A-10, A-11, A-13, R-01 – R-21 |
| Customer cannot access admin endpoints | R-01 – R-07 |
| Agent cannot access admin-only functionality | R-16 – R-21 |
| Customer cannot access another customer's ticket | R-08, R-09, R-10 |
| Ticket create | T-01 – T-04 |
| Ticket read | T-05 – T-07 |
| Ticket update | T-08, T-09 |
| Ticket delete where permitted | T-10, T-11, R-14, R-19 |
| Status transitions | T-15 – T-22, L-01 – L-05 |
| Assignment | T-12 – T-14 |
| Valid ticket reaches the AI service | AI-08, AI-09 |
| **AI failure does not crash ticket creation** | **AI-11** |
| **Agent can edit the AI response before sending** | **AI-12, AI-13** |
| Successful API requests | T-01, T-05, T-27 – T-32 |
| Invalid API requests | T-02, T-07, T-22, T-24, T-33 |
| Unauthorised API requests | R-01 – R-21 |
| Not-found cases | T-06, R-08 |

---

## What is not covered

Stated so the coverage claim is accurate:

- **No frontend component tests.** The interface was verified manually in a browser against the running stack: all three roles, ticket creation with live classification, the AI draft-and-edit flow, every dashboard chart, and the responsive layout at 375 px. That manual pass found the Recharts animation defect described in the frontend commit.
- **No load or performance testing.** Response times are acceptable at demonstration scale but have not been measured under concurrency.
- **The live Anthropic provider path is not exercised by automated tests**, because that would require a network call and an API key, making the suite non-deterministic. The adapter's failure handling *is* tested by forcing failures (AI-11) and by the fallback tests.
- **No end-to-end browser automation.** Manual verification stands in for it.
