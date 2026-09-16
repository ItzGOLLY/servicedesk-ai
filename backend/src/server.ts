import { createApp } from './app';
import { env } from './config/env';
import { aiStatus } from './services/ai';
import { closePool, pool } from './db/pool';
import { loggerFor } from './observability/logger';

const log = loggerFor('server');

async function start(): Promise<void> {
  // Fail loudly at boot if the database is unreachable, rather than serving
  // requests that will all 500.
  try {
    await pool.query('SELECT 1');
    log.info('database connection ok');
  } catch (error) {
    log.error({ err: (error as Error).message }, 'cannot reach the database');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    log.info(
      {
        port: env.port,
        nodeEnv: env.nodeEnv,
        corsOrigins: env.corsOrigins,
        aiProvider: aiStatus.active,
        aiFallback: aiStatus.usingFallback,
      },
      'server listening'
    );
  });

  // Render sends SIGTERM on redeploy; finish in-flight requests before exiting.
  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
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
