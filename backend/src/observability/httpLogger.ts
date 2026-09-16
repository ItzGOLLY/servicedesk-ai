import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { isTest } from '../config/env';

/**
 * Per-request logging.
 *
 * Every request is given an id and echoed back as X-Request-Id, so a
 * user-reported failure can be traced to exactly one log line. Duration and
 * status come from pino-http rather than being timed by hand.
 */
export const httpLogger = pinoHttp({
  logger,

  // Silent in tests; in normal operation the health endpoint is excluded
  // because it is polled every few minutes to keep the instance awake and
  // would otherwise bury real traffic.
  autoLogging: isTest ? false : { ignore: (req) => req.url === '/api/health' },

  genReqId: (req, res) => {
    // Honour an upstream id if a proxy already assigned one.
    const existing = req.headers['x-request-id'];
    const id = typeof existing === 'string' && existing ? existing : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },

  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,

  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
