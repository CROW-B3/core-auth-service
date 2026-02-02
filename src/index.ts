import type { Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { LOCAL_ORIGINS, PROD_ORIGINS } from './constants';
import { validateEnv } from './config/validate-env';
import { createLogger } from './config/logger';
import { handleErrorResponse } from './utils/error-handler';
import { HealthCheckRoute, ReadinessCheckRoute } from './routes/health';
import { createAuth } from './lib/auth';
import jwtRoutes from './routes/jwt';
import onboardingRoutes from './routes/onboarding';
import teamInvitationRoutes from './routes/team-invitations';

function getAllowedOrigins(env: Environment): string[] {
  if (env.ENVIRONMENT === 'local') {
    return [...PROD_ORIGINS, ...LOCAL_ORIGINS];
  }
  return PROD_ORIGINS;
}

function createCorsMiddleware(env: Environment) {
  return cors({
    origin: getAllowedOrigins(env),
    credentials: true,
  });
}

async function checkDatabaseHealth(db: ReturnType<typeof drizzle>): Promise<boolean> {
  try {
    await db.run('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const app = new OpenAPIHono<{ Bindings: Environment }>();

app.use(honoLogger());

app.use('*', async (c, next) => {
  try {
    validateEnv(c.env);
  } catch (error) {
    const logger = createLogger(c.env);
    return handleErrorResponse(c, error, logger);
  }

  await next();
});

app.use('/api/v1/*', async (c, next) => {
  const corsMiddleware = createCorsMiddleware(c.env);
  return corsMiddleware(c, next);
});

app.openapi(HealthCheckRoute, c => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'core-auth-service',
    version: '1.0.0',
    environment: c.env.ENVIRONMENT || 'prod',
  });
});

app.openapi(ReadinessCheckRoute, async c => {
  const database = drizzle(c.env.DB, { schema });
  const isDatabaseHealthy = await checkDatabaseHealth(database);

  const isReady = isDatabaseHealthy;
  const statusCode = isReady ? 200 : 503;

  return c.json({
    ready: isReady,
    checks: {
      database: isDatabaseHealthy,
    },
  }, statusCode);
});

app.route('/api/v1/auth/jwt', jwtRoutes);
app.route('/api/v1/auth/onboarding', onboardingRoutes);
app.route('/api/v1/auth/team-invitations', teamInvitationRoutes);

app.on(['GET', 'POST'], '/api/v1/auth/*', c =>
  createAuth(c.env).handler(c.req.raw)
);

app.get(
  '/',
  cache({
    cacheName: 'core-auth-service',
    cacheControl: 'max-age=300',
  }),
  c => c.json({ status: 'ok', service: 'core-auth-service' })
);

app.doc('/api/docs', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'CROW Auth API',
    description: 'Authentication and authorization service for CROW platform',
  },
});

app.notFound(c =>
  c.json({ error: 'Not Found', message: 'Route not found' }, 404)
);

app.onError((error, c) => {
  const logger = createLogger(c.env);
  return handleErrorResponse(c, error, logger);
});

export default app;
