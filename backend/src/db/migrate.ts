import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool } from './pool';
import { loggerFor } from '../observability/logger';

const log = loggerFor('migrate');

/**
 * Applies every .sql file in migrations/ in filename order, once each.
 *
 * Deliberately simple: a schema_migrations table records what has already run,
 * so re-running the command is safe and the whole mechanism fits on one screen.
 */
async function migrate(): Promise<void> {
  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations'
  );
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      log.info({ file }, 'migration already applied');
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.info({ file }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      const detail = (error as Error).message;

      // Managed providers run the application as a non-superuser, and most do
      // not treat pgvector as a trusted extension. The database owner can
      // still create it by hand, after which this migration is a no-op — but
      // the raw message does not say so, and this is the first thing a new
      // deployment hits.
      if (/permission denied to create extension/i.test(detail)) {
        throw new Error(
          `Migration ${file} failed: ${detail}\n` +
            'The database user may not create extensions. Run this once as the ' +
            'database owner (for example in your provider\u2019s SQL console), then deploy again:\n' +
            '  CREATE EXTENSION IF NOT EXISTS vector;'
        );
      }

      throw new Error(`Migration ${file} failed: ${detail}`);
    } finally {
      client.release();
    }
  }

  log.info('schema up to date');
}

migrate()
  .then(() => closePool())
  .catch(async (error) => {
    log.error({ err: error.message }, 'migration failed');
    await closePool();
    process.exit(1);
  });
