import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env, isTest } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './modules/authentication/auth.routes';
import { usersRouter } from './modules/user-management/users.routes';
import { ticketsRouter } from './modules/tickets/tickets.routes';
import { categoriesRouter } from './modules/administration/categories.routes';
import { auditRouter } from './modules/administration/audit.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { dashboardRouter } from './modules/reports/dashboard.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { aiRouter } from './modules/ai/ai.routes';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes';
import { knowledgeRouter } from './modules/knowledge/knowledge.routes';
import { pool } from './db/pool';
import { httpLogger } from './observability/httpLogger';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi/spec';

export function createApp(): Express {
  const app = express();

  // Render and Vercel put the app behind a proxy; without this, req.ip is the
  // proxy's address and the rate limiter would treat all users as one client.
  app.set('trust proxy', 1);

  // First in the chain so every request is logged, including ones later
  // rejected by CORS or the rate limiter.
  app.use(httpLogger);

  app.use(helmet());

  /**
   * CORS is an allow-list, not a wildcard: the browser only sends the refresh
   * cookie when a specific origin is echoed back and credentials are enabled.
   * Requests with no Origin header (curl, health checks) are allowed through.
   */
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS policy.`));
      },
      credentials: true,
    })
  );

  // The WhatsApp signature is computed over the raw body, so keep a copy
  // before any parser rewrites it.
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  };

  app.use(express.json({ limit: '1mb', verify: captureRawBody }));
  // Twilio posts form-encoded webhook bodies rather than JSON.
  app.use(express.urlencoded({ extended: false, limit: '1mb', verify: captureRawBody }));
  app.use(cookieParser());

  // Broad safety net; the auth routes add a stricter limit of their own.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 200,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => isTest,
    })
  );

  /**
   * Health check. Render pings this to decide whether the instance is live, and
   * it doubles as the keep-alive target that stops a free instance sleeping.
   */
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        success: true,
        data: { status: 'ok', database: 'connected', timestamp: new Date().toISOString() },
      });
    } catch {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is unreachable.' },
      });
    }
  });

  // Generated from the same Zod schemas that validate requests, so the
  // documentation cannot drift from the implementation.
  const openApiDocument = buildOpenApiDocument();

  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use(
    '/api/docs',
    // Helmet's default CSP blocks the inline styles Swagger UI needs, so it is
    // relaxed for this route only rather than globally.
    helmet({ contentSecurityPolicy: false }),
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'ServiceDesk AI — API',
      swaggerOptions: { persistAuthorization: true },
    })
  );

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/knowledge', knowledgeRouter);
  app.use('/api/whatsapp', whatsappRouter);
  app.use('/api/audit-logs', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
