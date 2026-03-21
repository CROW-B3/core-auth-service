import type { Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { drizzle } from 'drizzle-orm/d1';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { z } from 'zod';
import { createLogger } from './config/logger';
import { validateEnv } from './config/validate-env';
import { LOCAL_ORIGINS, PROD_ORIGINS } from './constants';
import * as schema from './db/schema';
import { createAuth } from './lib/auth';
import { syncOrgAndMember } from './lib/org-sync';
import { authRateLimiter } from './middleware/rate-limiter';
import { HealthCheckRoute, ReadinessCheckRoute } from './routes/health';
import jwtRoutes from './routes/jwt';
import onboardingRoutes from './routes/onboarding';
import onboardingCallbackRoutes from './routes/onboarding-callbacks';
import teamInvitationRoutes from './routes/team-invitations';
import { transformBetterAuthResponse } from './utils/auth-validation';
import { handleErrorResponse } from './utils/error-handler';

const HTML_TAG_REGEX = /<[^>]*>/;

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
  await next();
  c.header('Cache-Control', 'no-store, private');
});

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

app.use('/api/v1/auth/sign-in/*', authRateLimiter());
app.use('/api/v1/auth/sign-up/*', authRateLimiter());
app.use('/api/v1/auth/api-key/verify', authRateLimiter());
app.use('/api/v1/auth/jwt/system/generate', authRateLimiter());

app.use('/api/v1/auth/api-key/create', async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const bodyText = await c.req.raw
    .clone()
    .text()
    .catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  const nameResult = z.string().min(1).max(255).safeParse(body?.name);
  if (!nameResult.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'name is required and must be 1-255 characters',
          timestamp: new Date().toISOString(),
        },
      },
      400
    );

  try {
    const auth = createAuth(c.env);
    const session = await (auth.api as any).getSession({
      headers: c.req.raw.headers,
    });
    const betterAuthUserId = session?.user?.id ?? null;

    if (betterAuthUserId) {
      const serviceHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(c.env.INTERNAL_GATEWAY_KEY && {
          'X-Internal-Key': c.env.INTERNAL_GATEWAY_KEY,
        }),
        ...(c.env.SERVICE_API_KEY_USER && {
          'X-Service-API-Key': c.env.SERVICE_API_KEY_USER,
        }),
      };
      const userRes = await fetch(
        `${c.env.USER_SERVICE_URL}/api/v1/users/by-auth-id/${betterAuthUserId}`,
        { headers: serviceHeaders }
      );
      if (userRes.ok) {
        const userData = (await userRes.json()) as { organizationId?: string };
        if (userData.organizationId) {
          const existingMetadata =
            body?.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : {};
          const patchedBody = {
            ...body,
            metadata: {
              ...existingMetadata,
              organizationId: userData.organizationId,
            },
          };
          const patchedRequest = new Request(c.req.raw.url, {
            method: c.req.raw.method,
            headers: c.req.raw.headers,
            body: JSON.stringify(patchedBody),
          });
          c.req.raw = patchedRequest;
        }
      }
    }
  } catch (err) {
    console.error('[api-key/create] failed to inject organizationId:', err);
  }

  return next();
});

app.use('/api/v1/auth/sign-up/*', async (c, next) => {
  if (c.req.method !== 'POST') return next();

  const bodyText = await c.req.raw
    .clone()
    .text()
    .catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }

  const emailDomain = (body?.email as string | undefined)
    ?.split('@')[1]
    ?.toLowerCase();
  const blockedEmailDomains = new Set([
    'gmail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'x.com',
    'live.com',
    'msn.com',
    'icloud.com',
    'me.com',
    'aol.com',
    'yandex.com',
    'mail.com',
  ]);
  if (emailDomain && blockedEmailDomains.has(emailDomain)) {
    return c.json(
      {
        error: {
          code: 'DOMAIN_NOT_ALLOWED',
          message:
            'Consumer email domains are not accepted. Please use a business email address.',
          timestamp: new Date().toISOString(),
        },
      },
      400
    );
  }

  const emailResult = z.string().email().max(254).safeParse(body?.email);
  if (!emailResult.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'email must be a valid address and no longer than 254 characters',
          timestamp: new Date().toISOString(),
        },
      },
      400
    );
  }

  const nameResult = z.string().trim().min(1).max(255).safeParse(body?.name);

  if (!nameResult.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'name must be between 1 and 255 characters',
          timestamp: new Date().toISOString(),
        },
      },
      400
    );
  }

  if (HTML_TAG_REGEX.test(nameResult.data)) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'name must not contain HTML tags',
          timestamp: new Date().toISOString(),
        },
      },
      400
    );
  }

  return next();
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
    !path.includes('/onboarding') &&
    !path.includes('/team-invitations') &&
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

      if (path.includes('/organization/create') && response.status === 200) {
        try {
          const cloned = response.clone();
          const orgData = (await cloned.json()) as {
            id?: string;
            name?: string;
            members?: Array<{ userId: string; role: string }>;
          };
          if (orgData.id && orgData.name && orgData.members?.[0]) {
            const member = orgData.members[0];
            const syncPromise = syncOrgAndMember(
              c.env,
              orgData.id,
              orgData.name,
              member.userId,
              member.role
            );
            if (c.executionCtx?.waitUntil) {
              c.executionCtx.waitUntil(syncPromise);
            } else {
              await syncPromise;
            }
          }
        } catch (syncErr) {
          console.error('[org-create-sync] failed to parse/sync:', syncErr);
        }
      }

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
              : 'An error occurred',
          },
        },
        isJsonParseError ? 400 : 500
      );
    }
  }

  await next();
});

app.post('/api/v1/auth/api-key/verify', async c => {
  const internalKey = c.req.header('X-Internal-Key');
  const isInternalRequest =
    c.env.INTERNAL_GATEWAY_KEY && internalKey === c.env.INTERNAL_GATEWAY_KEY;
  if (!isInternalRequest) {
    const serviceKey = c.req.header('X-Service-API-Key');
    const knownServiceKeys = new Set(
      [
        c.env.SERVICE_API_KEY_USER,
        c.env.SERVICE_API_KEY_ORGANIZATION,
        c.env.SERVICE_API_KEY_BILLING,
        c.env.SERVICE_API_KEY_NOTIFICATION,
        c.env.SERVICE_API_KEY_PRODUCT,
        c.env.SERVICE_API_KEY_GATEWAY,
        c.env.SERVICE_API_KEY_WEB_INGEST,
      ].filter(Boolean)
    );
    if (!serviceKey || !knownServiceKeys.has(serviceKey)) {
      return c.json({ valid: false, error: 'Unauthorized' }, 401);
    }
  }

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

app.get('/', c => {
  const response = c.json({ status: 'ok', service: 'core-auth-service' });
  if (c.env.ENVIRONMENT !== 'local') {
    response.headers.set('Cache-Control', 'public, max-age=300');
  }
  return response;
});

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
