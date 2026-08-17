import dotenv from 'dotenv';

dotenv.config();

/** Reads a required variable, failing fast at boot rather than at first request. */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Copy .env.example to .env and fill it in.'
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),

  databaseUrl: required('DATABASE_URL'),
  databaseSsl: optional('DATABASE_SSL', 'false') === 'true',

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  accessTokenTtl: optional('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtl: optional('REFRESH_TOKEN_TTL', '7d'),

  // Comma-separated so a preview deployment and production can both be allowed.
  corsOrigins: optional('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  aiProvider: optional('AI_PROVIDER', 'fallback'),
  aiApiKey: process.env.AI_API_KEY ?? '',
  aiModel: optional('AI_MODEL', 'claude-sonnet-5'),
  aiTimeoutMs: Number(optional('AI_TIMEOUT_MS', '12000')),

  seedAdminEmail: optional('SEED_ADMIN_EMAIL', 'admin@servicedesk.ai'),
  seedAdminPassword: optional('SEED_ADMIN_PASSWORD', 'Admin@12345'),
};

export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';
