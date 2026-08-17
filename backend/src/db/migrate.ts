import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool } from './pool';

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
      console.log(`[migrate] skip     ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied  ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log('[migrate] up to date');
}

migrate()
  .then(() => closePool())
  .catch(async (error) => {
    console.error('[migrate] failed:', error.message);
    await closePool();
    process.exit(1);
  });
