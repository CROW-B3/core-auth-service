import type { Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { drizzle } from 'drizzle-orm/d1';
import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { createLogger } from './config/logger';
import { validateEnv } from './config/validate-env';
import { LOCAL_ORIGINS, PROD_ORIGINS } from './constants';
import * as schema from './db/schema';
import { createAuth } from './lib/auth';
import { HealthCheckRoute, ReadinessCheckRoute } from './routes/health';
import jwtRoutes from './routes/jwt';
import onboardingRoutes from './routes/onboarding';
import onboardingCallbackRoutes from './routes/onboarding-callbacks';
import teamInvitationRoutes from './routes/team-invitations';
import { transformBetterAuthResponse } from './utils/auth-validation';
import { handleErrorResponse } from './utils/error-handler';

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

async function checkDatabaseHealth(
  db: ReturnType<typeof drizzle>
): Promise<boolean> {
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

  return c.json(
    {
      ready: isReady,
      checks: {
        database: isDatabaseHealthy,
      },
    },
    statusCode
  );
});

app.use('/api/v1/auth/*', async (c, next) => {
  const path = c.req.path;

  const betterAuthPaths = [
    '/sign-up/',
    '/sign-in/',
    '/sign-out',
    '/session',
    '/get-session',
    '/user',
    '/callback/',
    '/verify-email',
    '/reset-password',
    '/change-password',
    '/forgot-password',
    '/update-user',
    '/link-social',
    '/list-sessions',
    '/organization/',
    '/invite/',
    '/token',
    '/jwks',
    '/api-key/',
  ];

  const customRoutes = [
    '/api/v1/auth/api-key/verify',
    '/api/v1/auth/api-key/system-token',
  ];

  const isBetterAuthRoute =
    !customRoutes.includes(path) &&
    betterAuthPaths.some(authPath => path.includes(authPath));

  if (isBetterAuthRoute) {
    try {
      let request = c.req.raw;
      if (c.req.method === 'POST') {
        const body = await c.req.raw.clone().text();
        if (!body || body.trim().length === 0) {
          request = new Request(c.req.raw.url, {
            method: 'POST',
            headers: c.req.raw.headers,
            body: '{}',
          });
        }
      }

      const response = await createAuth(c.env).handler(request);
      return transformBetterAuthResponse(response, path);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[BetterAuth] ${path}:`, errMsg);
      const isJsonParseError =
        error instanceof SyntaxError ||
        errMsg.toLowerCase().includes('unexpected token') ||
        errMsg.toLowerCase().includes('unexpected end of json');
      return c.json(
        {
          error: {
            code: isJsonParseError ? 'INVALID_JSON' : 'AUTH_ERROR',
            message: isJsonParseError
              ? 'Malformed JSON in request body'
              : errMsg,
            timestamp: new Date().toISOString(),
          },
        },
        isJsonParseError ? 400 : 500
      );
    }
  }

  await next();
});

app.post('/api/v1/auth/api-key/verify', async c => {
  const body = await c.req
    .json<{ key?: string }>()
    .catch(() => ({ key: undefined }));
  const key =
    body.key ??
    c.req.header('X-API-Key') ??
    c.req.header('Authorization')?.replace('Bearer ', '');
  if (!key) return c.json({ valid: false, error: 'Missing key' }, 400);

  const auth = createAuth(c.env);
  const result = await (auth.api as any)
    .verifyApiKey({ body: { key } })
    .catch(() => null);
  if (!result || !result.valid) return c.json({ valid: false }, 401);

  return c.json({ valid: true, key: result.key });
});

app.post('/api/v1/auth/api-key/system-token', async c => {
  const body = await c.req
    .json<{ key?: string }>()
    .catch(() => ({ key: undefined }));
  const key =
    body.key ??
    c.req.header('X-API-Key') ??
    c.req.header('Authorization')?.replace('Bearer ', '');
  if (!key) return c.json({ error: 'Missing key' }, 400);

  const auth = createAuth(c.env);
  const result = await (auth.api as any)
    .verifyApiKey({ body: { key } })
    .catch(() => null);
  if (!result?.valid) return c.json({ error: 'Invalid API key' }, 401);

  const { generateSystemJWT } = await import('./lib/system-jwt');
  const token = await generateSystemJWT(
    c.env.BETTER_AUTH_SECRET,
    'api-key-client'
  );

  return c.json({
    token,
    organizationId: result.key?.metadata?.organizationId ?? null,
    userId: result.key?.userId ?? null,
  });
});

app.route('/api/v1/auth/jwt', jwtRoutes);
app.route('/api/v1/auth/onboarding', onboardingRoutes);
app.route('/api/v1/auth/onboarding/callbacks', onboardingCallbackRoutes);
app.route('/api/v1/auth/team-invitations', teamInvitationRoutes);

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
