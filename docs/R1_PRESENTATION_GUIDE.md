# R1 Presentation Guide

**Review 1 · 20 August · 10 marks · Deck: `ServiceDesk_AI_Review1.pptx` (18 slides)**

Read this once tonight, then skim the Q&A section again in the morning.

---

## 0. The one thing to understand first

R1 asks only for **documents and design** — problem statement, requirements, use cases, mockups, initial SRS. No code is required.

**You have a working application.** That is your biggest advantage and your biggest risk.

- **The advantage:** while other teams present slides describing a plan, you can show the thing running. That is memorable.
- **The risk:** showing working code invites harder questions than a design review normally gets. If you show it, you must be able to explain it.

**Recommendation:** present the deck as the main body (it is exactly the R1 deliverables), and keep the running app as a closer — 60 seconds at the end, framed as "we have also started building." Do not lead with it. Lead with the requirements work, because that is what R1 is marked on.

---

## 1. Split the presentation

The guidelines require **both members to answer questions**. Do not let one person present everything.

| Slides | Presenter | Topic |
|---|---|---|
| 1–6 | **Aarush** | Title, problem, existing system, proposed system, objectives, scope |
| 7–11 | **Gomatheswar** | Users and access control, FR, NFR, use case diagram, ticket lifecycle |
| 12–14 | **Aarush** | UI mockups (customer, agent, admin) |
| 15–17 | **Gomatheswar** | Cloud architecture, AI design decision, roadmap |
| 18 + demo | **Both** | Close and questions |

Swap if you prefer — but **rehearse the swap out loud once**. The handover is where teams look unprepared.

---

## 2. Slide-by-slide script

Roughly 30–40 seconds per slide. Full speaker notes are already inside the `.pptx` (View → Notes Page).

**1 · Title.** "We are Aarush and Gomatheswar. Our project is ServiceDesk AI, Project 19 from the Customer Support SaaS category. The official problem statement is: manage customer complaints and automate ticket handling."

**2 · Problem Statement.** Read the official sentence, then immediately say you decomposed it: *"A single sentence is not a specification, so we did requirement analysis and found four concrete failures behind it — no single intake point, no ownership, no visible status, no measurement."* Walk the four.

**3 · Existing System.** Three approaches: shared inbox, spreadsheet, commercial helpdesk. One line of failure each. Close with the gap: *"a small business needs helpdesk structure without helpdesk pricing or complexity."*

**4 · Proposed System.** The seven-step workflow, briskly. Do not read every word — say *"a complaint becomes a ticket with an owner, a category, a priority and a status, which the customer can see, the agent can act on and the admin can measure."*

**5 · Objectives.** These are quoted from the specification. Say so — it shows you read the source document.

**6 · Scope.** In-scope briefly. **Spend your time on out-of-scope** — it shows judgement. Especially: *"we deliberately excluded fully autonomous AI replies, and I can explain why."*

**7 · Target Users and Access Control.** Three roles and the permission matrix. Emphasise: *"a customer cannot see another customer's ticket, and that is enforced in the API, not just hidden in the interface."*

**8 · Functional Requirements.** Ten official FRs. Do not read all ten aloud — say *"these are the ten from the specification; we expanded each into testable sub-requirements in the SRS"* and highlight three or four.

**9 · Non-Functional Requirements.** Six quality attributes. **Give a mechanism for each, not just the word.** "Security" alone scores nothing; "security — bcrypt password hashing, JWT sessions, role checks enforced server-side" scores.

**10 · Use Case Diagram.** Walk the three actors and count the use cases. Mention the two relationships: *"create ticket always includes classify ticket; generate AI draft extends reply to customer, because it is optional."*

**11 · Ticket Lifecycle.** Six states. Say the rule that makes it real: *"transitions are validated on the server against a single table, so a ticket cannot jump from New straight to Resolved."*

**12–14 · UI Mockups.** These are your differentiator — they are real screens, not wireframes. Point out: role-aware navigation, the AI assistance panel on the agent screen, and the responsive behaviour.

**15 · Cloud Architecture.** Frame as *"looking ahead to R2."* Three tiers, three platforms. One sentence on why stateless matters.

**16 · AI Design Decision.** **Be honest here — it earns marks.** *"The Project 19 specification does not require AI; only the title contains it. We added it, so we designed it so that no mandatory requirement depends on it."*

**17 · Roadmap.** R1 / R2 / R3 deliverables and what is planned when.

**18 · Close.** "Thank you — we are both happy to take questions."

**Optional 60-second closer:** *"We have also started implementation ahead of schedule — may we show you 30 seconds of it?"* Then: log in as customer → create a ticket → show it classified. Nothing more.

---

## 3. Questions you will probably get

Answer in two or three sentences. Do not over-explain.

**"Why this project / what is the real problem?"**
Small businesses lose complaints in shared inboxes. They have no ticket identity, no owner, no visible status and no measurement. Commercial helpdesks solve it but are priced per agent per month and assume a dedicated support team.

**"How is this cloud computing and not just a website?"**
Nothing runs on a machine we own. The database is a managed service, the API is a stateless container the platform can replicate, and the frontend is static content on a CDN. All three tiers deploy and scale independently, and it is reachable from any browser on the internet.

**"What is SaaS? Where are the other service models?"**
SaaS is finished software delivered over the internet as a centrally hosted multi-user service, with no client installation — that is our product. We build on PaaS (Vercel and Render manage the runtime) and DBaaS (managed PostgreSQL).

**"How is it multi-user?"**
Three roles share one deployment and one database. Any number of customers can be signed in at once, and each sees only their own tickets because every customer query is scoped to their own user id in the API.

**"How will you make it scalable?"**
The API holds no session state — sessions are signed tokens and everything else is in the database. That is what lets the platform run several replicas with no sticky sessions. Lists are paginated so responses do not grow with the dataset.

**"How are passwords stored?"**
As bcrypt hashes, never plain text. bcrypt salts each hash automatically, so two users with the same password store different hashes.

**"What is role-based access control and how do you enforce it?"**
Two layers, both on the server. A role check on the route decides whether a role may call an endpoint at all; an ownership check inside the handler decides whether that specific record belongs to the caller. Hiding buttons in the interface is not security.

**"Why PostgreSQL and not MongoDB?"**
The data is relational — a ticket belongs to one customer, may be assigned to one agent, and owns many messages. Foreign keys mean the database itself refuses an orphaned ticket. With a document database we would have to reimplement that in application code.

**"What are your entities?"**
Users, categories, tickets, ticket messages, ticket events, AI suggestions, notifications, audit logs.

**"Why REST APIs?"**
They give a clear contract between the frontend and backend over ordinary HTTP, so each can be deployed and scaled independently. Statelessness is what makes horizontal scaling possible.

**"What exactly does the AI do?"**
It proposes a category, priority and sentiment and writes a one-line summary when a ticket arrives, and it can draft a reply for an agent to review and edit. It assists the agent; it never messages a customer on its own.

**"What if the AI fails?"** *(they will ask this)*
Nothing user-visible breaks. Classification runs after the ticket is saved and is not waited on, so ticket creation cannot fail because of it. If the provider is unreachable we fall back to a rule-based classifier that runs locally, and the interface says so.

**"Why must a human approve AI replies?"**
A model can be confidently wrong about this particular customer's order, and a wrong promise about a refund is a real commercial problem. Also, a person should own what the business says to a customer.

**"How much have you built?"** *(if you show the demo)*
Answer honestly: the core application runs — authentication, roles, ticket CRUD and lifecycle, dashboards. It is not deployed yet; that is planned for R2.

**"What is your individual contribution?"**
**Prepare this yourselves tonight.** Agree who owns what and say it specifically. A vague answer here costs marks.

---

## 4. If you do not know an answer

Do not bluff. Faculty detect it instantly and it costs more than the missing answer.

Say: *"I do not have that detail memorised — it is in our SRS, section X. What I can tell you is…"* and give the part you do know.

If you genuinely disagree with a criticism, say so once, politely, with your reason. Then accept the feedback and move on.

---

## 5. Priority if you only have two hours tonight

In order. Stop when you run out of time.

1. **Read this guide's Q&A section twice.** Highest value per minute.
2. **Rehearse the deck out loud once, end to end, with the actual slide handover.** Silent reading does not expose the gaps.
3. **Read `docs/SRS.md` sections 2, 3, 4, 8 and 9** — problem, existing, proposed, FR, NFR. That is 80% of what R1 is marked on.
4. **Read `diagrams/use-case-diagram.md`** — you must be able to walk the diagram.
5. Agree and rehearse your individual-contribution answers.
6. Only if time remains: skim `docs/VIVA_PREPARATION.md` for the deeper technical questions.

---

## 6. Morning checklist

- [ ] Deck opens correctly on the presentation machine — **check fonts render**
- [ ] Export a PDF copy as backup (`ServiceDesk_AI_Review1.pdf`) and put it on a USB drive
- [ ] SRS and use case diagram accessible (printed or on screen) in case they ask to see them
- [ ] If demoing: both servers started and tested **before** you walk in, with a customer already registered
- [ ] Repository open in a browser tab
- [ ] Both of you know which slides you present
- [ ] Both of you have your individual-contribution answer ready

---

## 7. What R1 is actually marked on

Ten marks, and they are for the **requirements and design work** — not for how much code exists. Concretely:

- Did you understand the problem, or just restate the one-line specification? *(slides 2–3)*
- Are the requirements specific and testable, or generic? *(slides 8–9)*
- Does the use case diagram match what you say the system does? *(slide 10)*
- Do the mockups show a thought-through interface? *(slides 12–14)*
- Is the SRS complete?
- **Can both of you answer questions?**

The last one is where teams lose marks. Everything else is already on paper.
