-- ---------------------------------------------------------------------------
-- 006 — Multi-tenant WhatsApp integration platform.
--
-- The product changes shape here. Until now one business (us) owned one
-- WhatsApp number. From here the system is a Tech Provider: many businesses
-- onboard their OWN WhatsApp numbers through Meta's Embedded Signup, and every
-- row of data belongs to exactly one of them.
--
-- Three rules this migration establishes and the rest of the code relies on:
--
--   1. Every tenant-owned table carries tenant_id NOT NULL. There is no
--      "global" ticket, category or contact.
--   2. phone_number_id is globally unique and is the routing key: one webhook
--      endpoint serves every tenant, and the number the message arrived on is
--      what decides whose data it becomes.
--   3. Access tokens are never stored in plaintext. wa_connections holds an
--      AES-256-GCM ciphertext plus a fingerprint that is safe to log.
--
-- Existing data is preserved: a default tenant is created and everything that
-- exists today is attributed to it, so the deployed helpdesk keeps working
-- and simply becomes the platform's first tenant.
-- ---------------------------------------------------------------------------

-- --- tenants ---------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE tenant_status AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- Used in URLs and in the placeholder email of WhatsApp-created accounts,
  -- so it must be URL-safe.
  slug              CITEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status            tenant_status NOT NULL DEFAULT 'ACTIVE',
  -- When true the built-in helpdesk app consumes this tenant's inbound
  -- messages. A tenant using the platform purely as an API switches it off and
  -- receives everything on their own webhook instead.
  helpdesk_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  contact_email     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_tenants_updated ON tenants;
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The tenant every pre-existing row is attributed to.
INSERT INTO tenants (name, slug, contact_email)
VALUES ('ServiceDesk Demo', 'demo', 'admin@servicedesk.ai')
ON CONFLICT (slug) DO NOTHING;

-- --- tenant_id on everything that is tenant-owned ---------------------------

-- Added nullable, backfilled, then constrained, so the migration is safe on a
-- database that already holds data.
ALTER TABLE users             ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE categories        ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE kb_articles       ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE users             SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo') WHERE tenant_id IS NULL;
UPDATE categories        SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo') WHERE tenant_id IS NULL;
UPDATE tickets           SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo') WHERE tenant_id IS NULL;
UPDATE kb_articles       SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo') WHERE tenant_id IS NULL;
UPDATE whatsapp_messages SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo') WHERE tenant_id IS NULL;

ALTER TABLE users             ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE categories        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE tickets           ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE kb_articles       ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE whatsapp_messages ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant      ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant    ON tickets (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_tenant         ON kb_articles (tenant_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_tenant ON whatsapp_messages (tenant_id, created_at DESC);

-- A category name is unique within a business, not across the platform:
-- two tenants may both have "Billing".
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
DO $$ BEGIN
  ALTER TABLE categories ADD CONSTRAINT categories_tenant_name_unique UNIQUE (tenant_id, name);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- The same person may be a customer of several businesses on the platform, so
-- a WhatsApp number identifies someone only within one tenant.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_whatsapp_number_unique;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_tenant_whatsapp_unique UNIQUE (tenant_id, whatsapp_number);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- users.email stays globally unique: a sign-in credential belongs to one
-- business. Accounts created from an inbound WhatsApp message get a
-- tenant-scoped placeholder address, so two tenants cannot collide.

-- --- onboarded WhatsApp accounts -------------------------------------------

DO $$ BEGIN
  CREATE TYPE wa_connection_status AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISCONNECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS wa_connections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Meta is splitting the WABA into a WhatsApp account (numbers, identity) and
  -- a Messaging account (templates, billing, webhooks). Existing waba_id
  -- values now denote the Messaging account, so that is what this column is;
  -- waac_id is recorded when the newer id is available.
  waba_id                 TEXT NOT NULL UNIQUE,
  waac_id                 TEXT,
  business_id             TEXT,
  business_name           TEXT,

  -- AES-256-GCM. The fingerprint is the first 12 hex characters of the
  -- SHA-256 of the token: enough to tell two tokens apart in a log, useless
  -- to anyone who reads the log.
  access_token_encrypted  TEXT NOT NULL,
  token_fingerprint       TEXT NOT NULL,

  status                  wa_connection_status NOT NULL DEFAULT 'PENDING',
  error_detail            TEXT,
  subscribed_at           TIMESTAMPTZ,
  onboarded_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_wa_connections_updated ON wa_connections;
CREATE TRIGGER trg_wa_connections_updated BEFORE UPDATE ON wa_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_wa_connections_tenant ON wa_connections (tenant_id);

-- --- phone numbers: the routing table --------------------------------------

CREATE TABLE IF NOT EXISTS wa_numbers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id     UUID NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,

  -- Globally unique because it is how an inbound webhook finds its tenant.
  -- Meta guarantees uniqueness; asserting it here means a routing bug becomes
  -- a constraint violation rather than one tenant reading another's messages.
  phone_number_id   TEXT NOT NULL UNIQUE,

  display_number    TEXT NOT NULL,
  verified_name     TEXT,
  quality_rating    TEXT,
  registered        BOOLEAN NOT NULL DEFAULT FALSE,
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_wa_numbers_updated ON wa_numbers;
CREATE TRIGGER trg_wa_numbers_updated BEFORE UPDATE ON wa_numbers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_wa_numbers_tenant ON wa_numbers (tenant_id);

-- At most one default number per tenant, enforced rather than assumed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_numbers_one_default
  ON wa_numbers (tenant_id) WHERE is_default;

-- Which number a logged message belongs to, so per-number analytics are possible.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS number_id UUID REFERENCES wa_numbers(id) ON DELETE SET NULL;

-- Lets an API client safely retry a send after a timeout: the second call
-- finds the first and returns it instead of messaging the customer twice.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_idempotency
  ON whatsapp_messages (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The idempotency guarantee becomes per-tenant: two tenants could in principle
-- be delivered the same provider id, and one must not silence the other.
ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_provider_message_id_key;
DO $$ BEGIN
  ALTER TABLE whatsapp_messages
    ADD CONSTRAINT wa_messages_tenant_provider_unique UNIQUE (tenant_id, provider_message_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- --- API keys ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (btrim(name) <> ''),

  -- The caller sends "sdk_live_<prefix><secret>". Only the prefix is stored in
  -- the clear, so a key can be identified in the console and in logs; the full
  -- key is stored as a SHA-256 hash and shown to the user exactly once.
  prefix        TEXT NOT NULL UNIQUE,
  key_hash      TEXT NOT NULL,

  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);

-- --- outbound webhooks to tenants ------------------------------------------

DO $$ BEGIN
  CREATE TYPE webhook_delivery_status AS ENUM ('PENDING', 'DELIVERED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url         TEXT NOT NULL CHECK (url ~ '^https?://'),
  -- Shared secret the tenant verifies our HMAC-SHA256 signature with.
  secret      TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  events      TEXT[] NOT NULL DEFAULT ARRAY['message.received', 'message.status'],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_webhook_endpoints_updated ON webhook_endpoints;
CREATE TRIGGER trg_webhook_endpoints_updated BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          webhook_delivery_status NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_delivery_delivered_consistent
    CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant ON webhook_deliveries (tenant_id, created_at DESC);
-- Supports the dispatcher's "what is due now" query without a full scan.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at) WHERE status = 'PENDING';

-- --- message templates ------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id     UUID REFERENCES wa_connections(id) ON DELETE SET NULL,

  meta_template_id  TEXT,
  name              TEXT NOT NULL CHECK (name ~ '^[a-z0-9_]{1,512}$'),
  language          TEXT NOT NULL DEFAULT 'en',
  category          TEXT NOT NULL DEFAULT 'UTILITY'
                      CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  -- Mirrors Meta's own status vocabulary rather than inventing one.
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
  header_text       TEXT,
  body_text         TEXT NOT NULL CHECK (btrim(body_text) <> ''),
  footer_text       TEXT,
  variable_count    INTEGER NOT NULL DEFAULT 0 CHECK (variable_count >= 0),
  rejection_reason  TEXT,
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, name, language)
);

DROP TRIGGER IF EXISTS trg_message_templates_updated ON message_templates;
CREATE TRIGGER trg_message_templates_updated BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_templates_tenant ON message_templates (tenant_id, status);

-- --- contacts and broadcasts ------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_number       TEXT NOT NULL CHECK (wa_number ~ '^\+[1-9][0-9]{7,14}$'),
  name            TEXT,
  -- Meta requires opt-in for business-initiated messages; a broadcast must
  -- skip anyone who has not given it, so it is a first-class column.
  opted_in        BOOLEAN NOT NULL DEFAULT TRUE,
  attributes      JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_inbound_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, wa_number)
);

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts (tenant_id);

CREATE TABLE IF NOT EXISTS broadcasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (btrim(name) <> ''),
  template_id   UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  number_id     UUID REFERENCES wa_numbers(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'SENDING', 'COMPLETED', 'FAILED')),
  total_count   INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant ON broadcasts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id        UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  wa_number           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  provider_message_id TEXT,
  error_detail        TEXT,
  sent_at             TIMESTAMPTZ,

  UNIQUE (broadcast_id, wa_number)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients ON broadcast_recipients (broadcast_id, status);

-- --- usage metering ---------------------------------------------------------

-- One row per billable or countable action. Deliberately append-only and
-- denormalised: analytics aggregate it, nothing mutates it.
CREATE TABLE IF NOT EXISTS usage_events (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  number_id    UUID REFERENCES wa_numbers(id) ON DELETE SET NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_kind ON usage_events (tenant_id, kind, occurred_at DESC);
