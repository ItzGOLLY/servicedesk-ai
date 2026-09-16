-- Grounded (RAG) answers were being stored under RESOLUTION_STEPS, mixing two
-- payload shapes under one kind and making analytics by kind ambiguous. They
-- get their own value.
ALTER TYPE ai_suggestion_kind ADD VALUE IF NOT EXISTS 'GROUNDED_ANSWER';
