import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Environment } from '../types';
import { zValidator } from '@hono/zod-validator';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import * as schema from '../db/schema';
import { createSystemHeaders } from '../lib/system-jwt';
import { jwtAuth } from '../middleware/auth';
import * as onboardingService from '../services/onboarding';

const onboardingRoutes = new Hono<{ Bindings: Environment }>();

const handleHttpException = (exception: HTTPException, context: Context) => {
  return context.json({ error: exception.message }, exception.status);
};

const handleJsonSyntaxError = (error: SyntaxError, context: Context) => {
  if (!error.message.includes('JSON')) return null;
  return context.json({ error: 'Malformed JSON in request body' }, 400);
};

const handleGenericError = (error: Error, context: Context) => {
  console.error('Onboarding route error:', error);
  return context.json({ error: 'Internal server error' }, 500);
};

onboardingRoutes.onError((err, context) => {
  if (err instanceof HTTPException) {
    return handleHttpException(err, context);
  }

  if (err instanceof SyntaxError) {
    const response = handleJsonSyntaxError(err, context);
    if (response) return response;
  }

  return handleGenericError(err, context);
});

const startOnboardingSchema = z.object({
  betterAuthUserId: z.string(),
});

const completeProfileStepSchema = z.object({
  name: z.string().min(1).max(255),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  betterAuthUserId: z.string(),
});

const organizationStepSchema = z.object({
  betterAuthOrgId: z.string(),
  organizationName: z.string(),
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
  jobId: z.string().optional(),
});

const sourceStepSchema = z.object({
  sourceType: z.enum(['web', 'cctv', 'social']),
  apiKeyId: z.string(),
});

const checkoutStepSchema = z.object({
  stripeSessionId: z.string(),
});

const handleStartOnboarding = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const { betterAuthUserId } = (await context.req.json()) as {
    betterAuthUserId: string;
  };

  const result = await onboardingService.startOnboarding(
    database,
    betterAuthUserId
  );
  if (result.redirect) return context.json({ redirect: result.redirect });
  return context.json({ onboarding: result.onboarding }, 201);
};

onboardingRoutes.post(
  '/start',
  jwtAuth(),
  zValidator('json', startOnboardingSchema),
  handleStartOnboarding
);

const handleGetOnboardingById = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.getOnboardingStatus(
    database,
    onboardingId
  );
  if (!onboarding) return context.json({ error: 'Onboarding not found' }, 404);

  return context.json({ onboarding });
};

const handleGetOnboardingByUserId = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const userId = context.req.param('userId');

  const onboarding = await onboardingService.getOnboardingByUserId(
    database,
    userId
  );
  if (!onboarding) return context.json({ error: 'Onboarding not found' }, 404);

  return context.json({ onboarding });
};

onboardingRoutes.get('/user/:userId', handleGetOnboardingByUserId);

onboardingRoutes.get('/:id', handleGetOnboardingById);

const handleCompleteProfileStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as {
    name: string;
    phone?: string;
    jobTitle?: string;
    betterAuthUserId: string;
  };

  const onboarding = await onboardingService.processCompleteProfileStep(
    database,
    onboardingId,
    body,
    {
      BETTER_AUTH_SECRET: context.env.BETTER_AUTH_SECRET,
      USER_SERVICE_URL: context.env.USER_SERVICE_URL,
      INTERNAL_GATEWAY_KEY: context.env.INTERNAL_GATEWAY_KEY,
      SERVICE_API_KEY_USER: context.env.SERVICE_API_KEY_USER,
    }
  );

  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/complete-profile',
  zValidator('json', completeProfileStepSchema),
  handleCompleteProfileStep
);

const handleOrganizationStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as {
    betterAuthOrgId: string;
    organizationName: string;
    betterAuthUserId: string;
  };

  const onboarding = await onboardingService.processOrganizationStep(
    database,
    onboardingId,
    body,
    {
      BETTER_AUTH_SECRET: context.env.BETTER_AUTH_SECRET,
      USER_SERVICE_URL: context.env.USER_SERVICE_URL,
      ORGANIZATION_SERVICE_URL: context.env.ORGANIZATION_SERVICE_URL,
      BILLING_SERVICE_URL: context.env.BILLING_SERVICE_URL,
      INTERNAL_GATEWAY_KEY: context.env.INTERNAL_GATEWAY_KEY,
      SERVICE_API_KEY_ORGANIZATION: context.env.SERVICE_API_KEY_ORGANIZATION,
      SERVICE_API_KEY_USER: context.env.SERVICE_API_KEY_USER,
      SERVICE_API_KEY_BILLING: context.env.SERVICE_API_KEY_BILLING,
    }
  );

  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/organization',
  zValidator('json', organizationStepSchema),
  handleOrganizationStep
);

const handlePlanStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as {
    modules: { web: boolean; cctv: boolean; social: boolean };
    payAsYouGo: boolean;
    billingPeriod: 'monthly' | 'annual';
  };

  const onboarding = await onboardingService.processPlanStep(
    database,
    onboardingId,
    body,
    context.env.BILLING_SERVICE_URL,
    context.env.BETTER_AUTH_SECRET,
    context.env.INTERNAL_GATEWAY_KEY
  );

  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/plan',
  zValidator('json', planStepSchema),
  handlePlanStep
);

const handleCheckoutStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as { stripeSessionId: string };

  const onboarding = await onboardingService.processCheckoutStep(
    database,
    onboardingId,
    body.stripeSessionId
  );

  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/checkout',
  zValidator('json', checkoutStepSchema),
  handleCheckoutStep
);

const handleProductsStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as {
    sourceType: 'csv' | 'json' | 'url';
    sourceValue: string;
    jobId?: string;
  };

  const onboarding = await onboardingService.processProductsStep(
    database,
    onboardingId,
    body
  );
  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/products',
  zValidator('json', productsStepSchema),
  handleProductsStep
);

const handleSourceStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');
  const body = (await context.req.json()) as {
    sourceType: 'web' | 'cctv' | 'social';
    apiKeyId: string;
  };

  const onboarding = await onboardingService.processSourceStep(
    database,
    onboardingId,
    body
  );
  return context.json({ onboarding });
};

onboardingRoutes.patch(
  '/:id/step/sources',
  zValidator('json', sourceStepSchema),
  handleSourceStep
);

const handleSkipSourcesStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.skipSourcesStep(
    database,
    onboardingId
  );
  return context.json({ onboarding });
};

onboardingRoutes.patch('/:id/step/sources/skip', handleSkipSourcesStep);

const handleSkipProductsStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.skipProductsStep(
    database,
    onboardingId
  );
  return context.json({ onboarding });
};

onboardingRoutes.patch('/:id/step/products/skip', handleSkipProductsStep);

const handleTeamStep = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.processTeamStep(
    database,
    onboardingId
  );
  return context.json({ onboarding });
};

onboardingRoutes.patch('/:id/step/team', handleTeamStep);

const handleCompleteOnboarding = async (context: Context) => {
  const database = drizzle(context.env.DB, { schema });
  const onboardingId = context.req.param('id');

  const onboarding = await onboardingService.completeOnboarding(
    database,
    onboardingId
  );
  return context.json({ onboarding });
};

onboardingRoutes.post('/:id/complete', handleCompleteOnboarding);

const createCheckoutSchema = z.object({
  billingBuilderId: z.string(),
  organizationId: z.string().optional(),
  organizationName: z.string().optional(),
  successUrl: z.string(),
  cancelUrl: z.string(),
});

const createCheckoutSession = async (
  billingServiceUrl: string,
  headers: Record<string, string>,
  body: {
    billingBuilderId: string;
    successUrl: string;
    cancelUrl: string;
    organizationName?: string;
  }
) => {
  const checkoutResponse = await fetch(
    `${billingServiceUrl}/api/v1/billing/checkout/session`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );

  if (!checkoutResponse.ok) {
    const errorBody = await checkoutResponse.text();
    throw new HTTPException(checkoutResponse.status as ContentfulStatusCode, {
      message: `Failed to create checkout session: ${errorBody}`,
    });
  }

  return checkoutResponse.json();
};

const handleCreateCheckout = async (context: Context) => {
  const body = (await context.req.json()) as {
    billingBuilderId: string;
    organizationId?: string;
    organizationName?: string;
    successUrl: string;
    cancelUrl: string;
  };
  const headers = await createSystemHeaders(
    context.env.BETTER_AUTH_SECRET,
    'auth-service'
  );
  if (context.env.INTERNAL_GATEWAY_KEY)
    headers['X-Internal-Key'] = context.env.INTERNAL_GATEWAY_KEY;
  headers['X-System-Token'] = '1';
  if (body.organizationId) {
    headers['X-Organization-Id'] = body.organizationId;
  }
  const { organizationId: _orgId, ...checkoutBody } = body;
  const checkoutData = await createCheckoutSession(
    context.env.BILLING_SERVICE_URL,
    headers,
    checkoutBody
  );
  return context.json(checkoutData);
};

onboardingRoutes.post(
  '/:id/create-checkout',
  zValidator('json', createCheckoutSchema),
  handleCreateCheckout
);

export default onboardingRoutes;
