-- Runs once on first container start (docker-entrypoint-initdb.d). Creates the
-- test database alongside the main one, so a volume wipe cannot leave the test
-- suite without a database, and enables pgvector in both.
CREATE DATABASE servicedesk_test OWNER servicedesk;
\c servicedesk_test
CREATE EXTENSION IF NOT EXISTS vector;
\c servicedesk
CREATE EXTENSION IF NOT EXISTS vector;
