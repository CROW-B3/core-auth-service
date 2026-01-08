import type { Environment } from './types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createAuth } from './lib/auth';

const app = new Hono<{ Bindings: Environment }>();

const getAllowedOrigins = (env: Environment) => {
  const origins = [
    'https://crowai.dev',
    'https://app.crowai.dev',
    'https://api.crowai.dev',
    'https://dev.crowai.dev',
    'https://dev.app.crowai.dev',
    'https://dev.api.crowai.dev',
  ];

  if (env.ENVIRONMENT === 'local') {
    origins.push(
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:8000'
    );
  }

  return origins;
};

app.use('/api/auth/*', async (c, next) => {
  const corsMiddleware = cors({
    origin: getAllowedOrigins(c.env),
    credentials: true,
  });
  return corsMiddleware(c, next);
});

app.use(logger());

app.on(['GET', 'POST'], '/api/auth/*', c => {
  return createAuth(c.env).handler(c.req.raw);
});

app.get('/', c => c.json({ status: 'ok', service: 'core-auth-service' }));

export default app;
