import type { Environment } from '../types';
import { zValidator } from '@hono/zod-validator';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { z } from 'zod';
import * as schema from '../db/schema';
import * as onboardingService from '../services/onboarding';

const onboardingRoutes = new Hono<{ Bindings: Environment }>();

const startOnboardingSchema = z.object({
  betterAuthUserId: z.string(),
});

const organizationStepSchema = z.object({
  organizationName: z.string().min(1),
  slug: z.string().min(1),
  betterAuthOrgId: z.string(),
  betterAuthUserId: z.string(),
});

const planStepSchema = z.object({
  modules: z.object({
    web: z.boolean(),
    cctv: z.boolean(),
    social: z.boolean(),
  }),
  payAsYouGo: z.boolean(),
  billingPeriod: z.enum(['monthly', 'annual']),
});

const productsStepSchema = z.object({
  sourceType: z.enum(['csv', 'json', 'url']),
  sourceValue: z.string(),
});

const sourceStepSchema = z.object({
  sourceType: z.enum(['web', 'cctv', 'social']),
  apiKeyId: z.string(),
});

onboardingRoutes.post(
  '/start',
  zValidator('json', startOnboardingSchema),
  async c => {
    const db = drizzle(c.env.DB, { schema });
    const { betterAuthUserId } = c.req.valid('json');

    const result = await onboardingService.startOnboarding(
      db,
      c.env,
      betterAuthUserId
    );

    if (result.redirect) return c.json({ redirect: result.redirect });
    return c.json({ onboarding: result.onboarding }, 201);
  }
);

onboardingRoutes.get('/:id', async c => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const onboarding = await onboardingService.getOnboardingStatus(db, id);
  if (!onboarding) return c.json({ error: 'Onboarding not found' }, 404);

  return c.json({ onboarding });
});

onboardingRoutes.get('/user/:userId', async c => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('userId');

  const onboarding = await onboardingService.getOnboardingByUserId(db, userId);
  if (!onboarding) return c.json({ error: 'Onboarding not found' }, 404);

  return c.json({ onboarding });
});

onboardingRoutes.patch(
  '/:id/step/organization',
  zValidator('json', organizationStepSchema),
  async c => {
    const db = drizzle(c.env.DB, { schema });
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const onboarding = await onboardingService.processOrganizationStep(
      db,
      c.env,
      id,
      body.betterAuthOrgId,
      body.betterAuthUserId,
      { organizationName: body.organizationName, slug: body.slug }
    );

    return c.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/plan',
  zValidator('json', planStepSchema),
  async c => {
    const db = drizzle(c.env.DB, { schema });
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const onboarding = await onboardingService.processPlanStep(
      db,
      c.env,
      id,
      body
    );

    return c.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/products',
  zValidator('json', productsStepSchema),
  async c => {
    const db = drizzle(c.env.DB, { schema });
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const onboarding = await onboardingService.processProductsStep(
      db,
      c.env,
      id,
      body
    );

    return c.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/sources',
  zValidator('json', sourceStepSchema),
  async c => {
    const db = drizzle(c.env.DB, { schema });
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const onboarding = await onboardingService.processSourceStep(db, id, body);

    return c.json({ onboarding });
  }
);

onboardingRoutes.patch('/:id/step/team', async c => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const onboarding = await onboardingService.processTeamStep(db, id);

  return c.json({ onboarding });
});

onboardingRoutes.post('/:id/complete', async c => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const onboarding = await onboardingService.completeOnboarding(db, id);

  return c.json({ onboarding });
});

export default onboardingRoutes;
