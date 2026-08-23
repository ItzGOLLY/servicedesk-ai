-- ---------------------------------------------------------------------------
-- WhatsApp as a first-class support channel.
--
-- Customers raise and follow tickets entirely from WhatsApp; agents work in the
-- web application and their replies are delivered back to the customer's chat.
-- ---------------------------------------------------------------------------

-- Which channel a ticket or message came from, or was delivered to.
DO $$ BEGIN
  CREATE TYPE ticket_channel AS ENUM ('WEB', 'WHATSAPP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wa_direction AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Delivery lifecycle of an outbound WhatsApp message.
DO $$ BEGIN
  CREATE TYPE wa_delivery_status AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- users: the WhatsApp identity
--
-- Stored separately from `phone` because a contact number is not necessarily a
-- WhatsApp number. Unique, because it is how an inbound message is resolved to
-- an account -- two users sharing one number would make that ambiguous.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_whatsapp_number_unique UNIQUE (whatsapp_number);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- Stored in E.164 (a leading + and digits only) so the value a webhook supplies
-- and the value we send to always match exactly.
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_whatsapp_number_e164
    CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^\+[1-9][0-9]{7,14}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users (whatsapp_number)
  WHERE whatsapp_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tickets and messages: channel provenance
-- ---------------------------------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel ticket_channel NOT NULL DEFAULT 'WEB';

ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS channel ticket_channel NOT NULL DEFAULT 'WEB';

CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel);

-- ---------------------------------------------------------------------------
-- whatsapp_messages
--
-- Every message in and out, kept for three reasons:
--   1. Idempotency. Providers retry webhooks, so the same inbound message can
--      arrive several times; provider_message_id is unique and makes the second
--      delivery a no-op instead of a duplicate ticket.
--   2. Delivery tracking. Outbound status arrives later in a separate callback.
--   3. Audit. A support conversation that happened off-platform still needs a
--      record on the platform.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction           wa_direction NOT NULL,

  -- The provider's own id. Unique so a replayed webhook cannot be processed twice.
  provider_message_id TEXT UNIQUE,

  wa_number           TEXT NOT NULL,
  body                TEXT NOT NULL,

  ticket_id           UUID REFERENCES tickets (id) ON DELETE SET NULL,
  message_id          UUID REFERENCES ticket_messages (id) ON DELETE SET NULL,
  user_id             UUID REFERENCES users (id) ON DELETE SET NULL,

  status              wa_delivery_status NOT NULL DEFAULT 'PENDING',
  error_detail        TEXT,
  provider            TEXT NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT whatsapp_messages_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_number
  ON whatsapp_messages (wa_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_ticket
  ON whatsapp_messages (ticket_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
  ON whatsapp_messages (status) WHERE direction = 'OUTBOUND';

DROP TRIGGER IF EXISTS trg_whatsapp_messages_updated_at ON whatsapp_messages;
CREATE TRIGGER trg_whatsapp_messages_updated_at BEFORE UPDATE ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
