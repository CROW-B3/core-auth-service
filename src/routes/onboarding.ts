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
  betterAuthOrgId: z.string(),
  orgBuilderId: z.string(),
  userBuilderId: z.string(),
  billingBuilderId: z.string(),
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
  jobId: z.string().optional(),
});

const sourceStepSchema = z.object({
  sourceType: z.enum(['web', 'cctv', 'social']),
  apiKeyId: z.string(),
});

const checkoutStepSchema = z.object({
  stripeSessionId: z.string(),
});

onboardingRoutes.post(
  '/start',
  zValidator('json', startOnboardingSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const { betterAuthUserId } = context.req.valid('json');

    const result = await onboardingService.startOnboarding(
      database,
      betterAuthUserId
    );

    if (result.redirect) return context.json({ redirect: result.redirect });
    return context.json({ onboarding: result.onboarding }, 201);
  }
);

onboardingRoutes.get('/:id', async context => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.getOnboardingStatus(
    database,
    onboardingId
  );
  if (!onboarding) return context.json({ error: 'Onboarding not found' }, 404);

  return context.json({ onboarding });
});

onboardingRoutes.get('/user/:userId', async context => {
  const database = drizzle(context.env.DB, { schema });
  const userId = context.req.param('userId');

  const onboarding = await onboardingService.getOnboardingByUserId(
    database,
    userId
  );
  if (!onboarding) return context.json({ error: 'Onboarding not found' }, 404);

  return context.json({ onboarding });
});

onboardingRoutes.patch(
  '/:id/step/organization',
  zValidator('json', organizationStepSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const onboardingId = context.req.param('id');
    const body = context.req.valid('json');

    const onboarding = await onboardingService.processOrganizationStep(
      database,
      onboardingId,
      body
    );

    return context.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/plan',
  zValidator('json', planStepSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const onboardingId = context.req.param('id');
    const body = context.req.valid('json');

    const onboarding = await onboardingService.processPlanStep(
      database,
      onboardingId,
      body
    );

    return context.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/checkout',
  zValidator('json', checkoutStepSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const onboardingId = context.req.param('id');
    const body = context.req.valid('json');

    const onboarding = await onboardingService.processCheckoutStep(
      database,
      onboardingId,
      body.stripeSessionId
    );

    return context.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/products',
  zValidator('json', productsStepSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const onboardingId = context.req.param('id');
    const body = context.req.valid('json');

    const onboarding = await onboardingService.processProductsStep(
      database,
      onboardingId,
      body
    );

    return context.json({ onboarding });
  }
);

onboardingRoutes.patch(
  '/:id/step/sources',
  zValidator('json', sourceStepSchema),
  async context => {
    const database = drizzle(context.env.DB, { schema });
    const onboardingId = context.req.param('id');
    const body = context.req.valid('json');

    const onboarding = await onboardingService.processSourceStep(
      database,
      onboardingId,
      body
    );

    return context.json({ onboarding });
  }
);

onboardingRoutes.patch('/:id/step/team', async context => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.processTeamStep(
    database,
    onboardingId
  );

  return context.json({ onboarding });
});

onboardingRoutes.post('/:id/complete', async context => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.completeOnboarding(
    database,
    onboardingId
  );

  return context.json({ onboarding });
});

export default onboardingRoutes;
