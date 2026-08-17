-- ---------------------------------------------------------------------------
-- ServiceDesk AI — initial schema
--
-- This file is the single source of truth for the database. The ER diagram in
-- docs/DATABASE_DESIGN.md is derived from it, so the diagram cannot drift away
-- from the real schema.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enumerated types
--
-- Roles are an enum rather than a separate table: the set of roles is fixed by
-- the project specification (Customer, Support Agent, Admin) and never edited
-- at runtime, so an enum gives the same guarantee with one fewer join.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('CUSTOMER', 'AGENT', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM (
    'NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_sentiment AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ai_suggestion_kind AS ENUM (
    'CLASSIFICATION', 'DRAFT_REPLY', 'SUMMARY', 'RESOLUTION_STEPS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  role           user_role NOT NULL DEFAULT 'CUSTOMER',
  phone          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_full_name_not_blank CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT users_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users (is_active);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT categories_name_not_blank CHECK (length(btrim(name)) > 0)
);

-- ---------------------------------------------------------------------------
-- tickets
--
-- reference is the human-facing identifier a customer quotes on the phone
-- ("SD-1024"). It is generated from a sequence so it is short and readable,
-- while id stays a UUID for API use.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS ticket_reference_seq START 1000;

CREATE TABLE IF NOT EXISTS tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         TEXT NOT NULL UNIQUE
                      DEFAULT ('SD-' || nextval('ticket_reference_seq')::TEXT),
  customer_id       UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  assigned_agent_id UUID REFERENCES users (id) ON DELETE SET NULL,
  category_id       UUID REFERENCES categories (id) ON DELETE SET NULL,

  subject           TEXT NOT NULL,
  description       TEXT NOT NULL,
  priority          ticket_priority NOT NULL DEFAULT 'MEDIUM',
  status            ticket_status NOT NULL DEFAULT 'NEW',
  sentiment         ticket_sentiment,

  -- AI-derived fields. Always nullable: a ticket must be creatable when the
  -- AI service is unavailable.
  ai_summary        TEXT,
  ai_confidence     NUMERIC(3, 2),
  ai_classified_at  TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_response_at TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,

  CONSTRAINT tickets_subject_not_blank CHECK (length(btrim(subject)) > 0),
  CONSTRAINT tickets_description_not_blank CHECK (length(btrim(description)) > 0),
  CONSTRAINT tickets_ai_confidence_range
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  -- A ticket may only carry a resolved timestamp while it is resolved or closed.
  CONSTRAINT tickets_resolved_at_consistent
    CHECK (resolved_at IS NULL OR status IN ('RESOLVED', 'CLOSED')),
  CONSTRAINT tickets_closed_at_consistent
    CHECK (closed_at IS NULL OR status = 'CLOSED')
);

CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON tickets (assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets (category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets (priority);
CREATE INDEX IF NOT EXISTS idx_tickets_sentiment ON tickets (sentiment);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets (created_at DESC);

-- Full-text search over subject + description, backing the ?q= filter.
CREATE INDEX IF NOT EXISTS idx_tickets_search ON tickets
  USING GIN (to_tsvector('english', subject || ' ' || description));

-- ---------------------------------------------------------------------------
-- ticket_messages — the conversation thread
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  author_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body             TEXT NOT NULL,
  -- Internal notes are visible to agents and admins only, never to the customer.
  is_internal_note BOOLEAN NOT NULL DEFAULT FALSE,
  -- TRUE when the author started from an AI draft. Powers the "AI-assisted
  -- ticket statistics" figure on the admin dashboard honestly.
  ai_assisted      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ticket_messages_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket
  ON ticket_messages (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- ticket_events — immutable per-ticket audit timeline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket
  ON ticket_events (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- ai_suggestions — every AI output, kept for review and statistics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  kind          ai_suggestion_kind NOT NULL,
  content       JSONB NOT NULL,
  model         TEXT NOT NULL,
  -- TRUE when the AI provider was unreachable and the rule-based fallback ran.
  used_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  was_accepted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_ticket ON ai_suggestions (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_kind ON ai_suggestions (kind);

-- ---------------------------------------------------------------------------
-- notifications — persistent in-app notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ticket_id  UUID REFERENCES tickets (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications (user_id, is_read, created_at DESC);

-- ---------------------------------------------------------------------------
-- audit_logs — every privileged action
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   UUID,
  metadata    JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
