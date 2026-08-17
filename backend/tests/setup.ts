import dotenv from 'dotenv';

// Loaded before any application module reads process.env.
dotenv.config({ path: '.env.test' });

process.env.NODE_ENV = 'test';
// Never let the test run reach a real AI provider: tests must be deterministic
// and must not depend on a network or an API key.
process.env.AI_PROVIDER = 'fallback';
