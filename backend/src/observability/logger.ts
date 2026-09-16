import pino from 'pino';
import { env, isProduction, isTest } from '../config/env';

/**
 * Structured logging.
 *
 * Production emits newline-delimited JSON, which is what hosting platforms and
 * log aggregators parse. Development pretty-prints instead, and tests are
 * silenced so suite output stays readable.
 *
 * The redaction list is the important part: an access token, a refresh cookie
 * or a provider key must never reach a log line, and relying on every future
 * call site to remember that would eventually fail.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.logLevel,
  base: { service: 'servicedesk-api', env: env.nodeEnv },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'currentPassword',
      'newPassword',
      'accessToken',
      'refreshToken',
      'apiKey',
      'authToken',
      '*.password',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,service,env',
          },
        },
      }),
});

/** A child logger tagged with its subsystem, so lines can be filtered. */
export const loggerFor = (component: string) => logger.child({ component });
