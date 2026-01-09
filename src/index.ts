import type { Environment } from './types';
import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { LOCAL_ORIGINS, PROD_ORIGINS } from './constants';
import { createAuth } from './lib/auth';

function getAllowedOrigins(env: Environment): string[] {
  if (env.ENVIRONMENT === 'local') {
    return [...PROD_ORIGINS, ...LOCAL_ORIGINS];
  }
  return PROD_ORIGINS;
}

const app = new Hono<{ Bindings: Environment }>();

app.use(logger());

app.use('/api/auth/*', async (c, next) => {
  const corsMiddleware = cors({
    origin: getAllowedOrigins(c.env),
    credentials: true,
  });
  return corsMiddleware(c, next);
});

app.on(['GET', 'POST'], '/api/auth/*', c =>
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

export default app;
