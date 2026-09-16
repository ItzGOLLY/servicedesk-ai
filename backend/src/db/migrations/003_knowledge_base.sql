-- ---------------------------------------------------------------------------
-- Knowledge base with vector retrieval (RAG).
--
-- Agents answer the same questions repeatedly. This stores the answers once, as
-- articles, and retrieves the relevant passages for a given ticket so the model
-- answers from the business's own documented material rather than from its
-- training data.
--
-- pgvector is used rather than a separate vector database: the corpus is small,
-- the articles are already relational data, and keeping retrieval in PostgreSQL
-- means one datastore, one backup, one connection pool and one thing to deploy.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- kb_articles — the human-authored source of truth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_articles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  category_id UUID REFERENCES categories (id) ON DELETE SET NULL,

  -- Unpublished articles are excluded from retrieval, so a draft cannot reach
  -- a customer through an AI answer.
  is_published BOOLEAN NOT NULL DEFAULT TRUE,

  author_id   UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT kb_articles_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT kb_articles_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_published ON kb_articles (is_published);
CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles (category_id);

-- Lexical search over articles, used to evaluate retrieval against a keyword
-- baseline and as a fallback when embeddings are unavailable.
CREATE INDEX IF NOT EXISTS idx_kb_articles_search ON kb_articles
  USING GIN (to_tsvector('english', title || ' ' || body));

-- ---------------------------------------------------------------------------
-- kb_chunks — retrieval unit
--
-- Whole articles are too coarse to retrieve: a 2,000-word article about
-- billing would drown the one paragraph that answers the question, and would
-- waste context window. Articles are therefore split into passages, and each
-- passage is embedded independently.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES kb_articles (id) ON DELETE CASCADE,

  -- Position within the article, so citations can point at a specific passage
  -- and so re-indexing is deterministic.
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,

  -- 384 dimensions: the deterministic offline provider and the hosted provider
  -- both emit this size (text-embedding-3-small supports dimension reduction),
  -- so the column type does not change when the provider changes.
  embedding   VECTOR(384),

  -- Which engine produced the embedding. Vectors from different models are not
  -- comparable, so this records what would need re-indexing after a switch.
  embedding_model TEXT,
  embedded_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT kb_chunks_content_not_blank CHECK (length(btrim(content)) > 0),
  CONSTRAINT kb_chunks_unique_position UNIQUE (article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_article ON kb_chunks (article_id);

-- IVFFlat with cosine distance. At this corpus size an exact scan is already
-- fast, but the index is what makes the design honest about scaling: lists=100
-- suits low thousands of chunks, and the index is only consulted when the
-- planner judges it cheaper than a sequential scan.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- kb_retrievals — what was retrieved, for evaluation and for showing citations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_retrievals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID REFERENCES tickets (id) ON DELETE CASCADE,
  query_text  TEXT NOT NULL,

  -- Ordered chunk ids with their distances, kept as JSONB because the shape is
  -- a result list rather than an entity.
  results     JSONB NOT NULL DEFAULT '[]'::JSONB,
  top_score   REAL,

  -- TRUE when embeddings were unavailable and lexical search was used instead.
  used_lexical_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_retrievals_ticket ON kb_retrievals (ticket_id);

DROP TRIGGER IF EXISTS trg_kb_articles_updated_at ON kb_articles;
CREATE TRIGGER trg_kb_articles_updated_at BEFORE UPDATE ON kb_articles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
