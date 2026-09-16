-- ---------------------------------------------------------------------------
-- Replace the IVFFlat vector index with HNSW.
--
-- WHY THIS CHANGED
--
-- IVFFlat is a clustering index: it partitions vectors into `lists` centroids
-- computed from the data present when the index is BUILT. Migration 003 created
-- it on an empty table, so no centroids existed. Every subsequent insert landed
-- outside the trained structure, and index scans returned almost nothing —
-- a query for the 3 nearest neighbours over 5 embedded chunks returned 1 row.
--
-- The failure is silent, which is what makes it dangerous: retrieval returns
-- fewer results rather than an error, so a RAG answer is simply less grounded
-- with no signal that anything is wrong.
--
-- HNSW builds a navigable graph incrementally as rows are inserted. It needs no
-- training pass and no populated table at creation time, so it is correct for a
-- corpus that starts empty and grows — which is every knowledge base.
--
-- Trade-off accepted: HNSW uses more memory and builds more slowly than a
-- trained IVFFlat. At this corpus size neither cost is material, and
-- correctness on an empty table is worth far more than build speed.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_kb_chunks_embedding;

-- m = 16 connections per node, ef_construction = 64: pgvector's defaults, which
-- are well-tested general-purpose values. Tuning them is only worthwhile with a
-- corpus large enough to measure the difference.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw ON kb_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
