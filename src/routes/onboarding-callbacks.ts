import type { Environment } from '../types';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as schema from '../db/schema';
import * as onboardingService from '../services/onboarding';

const callbackRoutes = new Hono<{ Bindings: Environment }>();

// All callbacks are internal-only: require the gateway internal key
callbackRoutes.use('*', async (c, next) => {
  if (!c.env.INTERNAL_GATEWAY_KEY) {
    return c.json({ error: 'Service unavailable' }, 503);
  }
  const key = c.req.header('X-Internal-Key');
  if (!key || key !== c.env.INTERNAL_GATEWAY_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

callbackRoutes.post('/organization-created', async c => {
  const database = drizzle(c.env.DB, { schema });
  const { onboardingId } = await c.req.json();

  await onboardingService.markStepCompleted(
    database,
    onboardingId,
    'organization'
  );

  return c.json({ success: true });
});

callbackRoutes.post('/modules-selected', async c => {
  const database = drizzle(c.env.DB, { schema });
  const { onboardingId } = await c.req.json();

  await onboardingService.markStepCompleted(database, onboardingId, 'modules');

  return c.json({ success: true });
});

callbackRoutes.post('/source-connected', async c => {
  const database = drizzle(c.env.DB, { schema });
  const { onboardingId, sourceType } = await c.req.json();

  await onboardingService.recordSourceConnection(
    database,
    onboardingId,
    sourceType
  );

  return c.json({ success: true });
});

export default callbackRoutes;
