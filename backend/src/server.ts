import { createApp } from './app';
import { env } from './config/env';
import { aiStatus } from './services/ai';
import { closePool, pool } from './db/pool';

async function start(): Promise<void> {
  // Fail loudly at boot if the database is unreachable, rather than serving
  // requests that will all 500.
  try {
    await pool.query('SELECT 1');
    console.log('[server] database connection ok');
  } catch (error) {
    console.error('[server] cannot reach the database:', (error as Error).message);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
    console.log(`[server] CORS origins: ${env.corsOrigins.join(', ')}`);
    console.log(
      `[server] AI: ${aiStatus.active}${aiStatus.usingFallback ? ' (rule-based fallback)' : ''}`
    );
  });

  // Render sends SIGTERM on redeploy; finish in-flight requests before exiting.
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
