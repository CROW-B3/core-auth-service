import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../db/schema';
import { createSystemHeaders } from '../lib/system-jwt';
import * as onboardingRepo from '../repositories/onboarding';

type Database = DrizzleD1Database<typeof schema>;

const appendStepToCompletedSteps = (
  existingSteps: string | null,
  newStep: string
): string[] => {
  const steps = JSON.parse(existingSteps || '[]') as string[];
  if (!steps.includes(newStep)) steps.push(newStep);
  return steps;
};

export interface StartOnboardingResult {
  onboarding: typeof schema.onboarding.$inferSelect;
  redirect?: string;
}

export const startOnboarding = async (
  database: Database,
  betterAuthUserId: string
): Promise<StartOnboardingResult> => {
  const existingOnboarding = await onboardingRepo.findOnboardingByUserId(
    database,
    betterAuthUserId
  );

  if (existingOnboarding) {
    if (existingOnboarding.status === 'completed') {
      return { onboarding: null as never, redirect: '/dashboard' };
    }

    if (existingOnboarding.status === 'in_progress') {
      return { onboarding: existingOnboarding };
    }

    await onboardingRepo.deleteOnboardingRecord(
      database,
      existingOnboarding.id
    );
  }

  const onboardingId = crypto.randomUUID();
  const onboarding = await onboardingRepo.createOnboardingRecord(database, {
    id: onboardingId,
    betterAuthUserId,
  });

  return { onboarding: onboarding! };
};

export interface OrganizationStepInput {
  betterAuthOrgId: string;
  organizationName: string;
  betterAuthUserId: string;
}

const fetchUserFromBetterAuth = async (database: Database, userId: string) => {
  const authUserQuery = await database.query.user.findFirst({
    where: (users, { eq }) => eq(users.id, userId),
  });

  if (!authUserQuery) {
    throw new Error('User not found in Better Auth');
  }

  return authUserQuery;
};

const createOrganizationViaService = async (
  env: { ORGANIZATION_SERVICE_URL?: string },
  systemHeaders: Record<string, string>,
  data: { betterAuthOrgId: string; organizationName: string }
) => {
  const organizationServiceUrl =
    env.ORGANIZATION_SERVICE_URL || 'http://localhost:8004';
  const organizationResponse = await fetch(
    `${organizationServiceUrl}/api/v1/organizations`,
    {
      method: 'POST',
      headers: systemHeaders,
      body: JSON.stringify({
        betterAuthOrgId: data.betterAuthOrgId,
        name: data.organizationName,
      }),
    }
  );

  if (!organizationResponse.ok) {
    const errorBody = await organizationResponse.text();
    console.error('Organization Service error:', {
      status: organizationResponse.status,
      statusText: organizationResponse.statusText,
      body: errorBody,
      url: `${organizationServiceUrl}/api/v1/organizations`,
    });
    throw new Error(
      `Failed to create organization: ${organizationResponse.status} ${errorBody}`
    );
  }

  return organizationResponse.json();
};

const fetchExistingUser = async (
  userServiceUrl: string,
  systemHeaders: Record<string, string>,
  authUserId: string
) => {
  const response = await fetch(
    `${userServiceUrl}/api/v1/users/by-auth-id/${authUserId}`,
    { headers: systemHeaders }
  );
  if (!response.ok) return null;
  return response.json();
};

const createNewUser = async (
  userServiceUrl: string,
  systemHeaders: Record<string, string>,
  authUser: { id: string; email: string; name: string },
  organizationId: string,
  onboardingId: string
) => {
  const userResponse = await fetch(`${userServiceUrl}/api/v1/users`, {
    method: 'POST',
    headers: systemHeaders,
    body: JSON.stringify({
      betterAuthUserId: authUser.id,
      organizationId,
      email: authUser.email,
      name: authUser.name,
      role: 'admin',
      modules: { web: true, cctv: true, social: true },
      onboardingId,
    }),
  });

  if (!userResponse.ok) {
    const errorBody = await userResponse.text();
    console.error('User Service error:', {
      status: userResponse.status,
      statusText: userResponse.statusText,
      body: errorBody,
    });
    throw new Error(
      `Failed to create user: ${userResponse.status} ${errorBody}`
    );
  }

  return userResponse.json();
};

const ensureUserExistsInService = async (
  env: { USER_SERVICE_URL: string },
  systemHeaders: Record<string, string>,
  authUser: { id: string; email: string; name: string },
  organization: { id: string },
  onboardingId: string
) => {
  const existingUser = await fetchExistingUser(
    env.USER_SERVICE_URL,
    systemHeaders,
    authUser.id
  );
  if (existingUser) return existingUser;
  return createNewUser(
    env.USER_SERVICE_URL,
    systemHeaders,
    authUser,
    organization.id,
    onboardingId
  );
};

const createBillingBuilderForOrganization = async (
  env: { BILLING_SERVICE_URL: string },
  systemHeaders: Record<string, string>,
  organization: { id: string },
  onboardingId: string
) => {
  const billingResponse = await fetch(
    `${env.BILLING_SERVICE_URL}/api/v1/billing/billing-builders`,
    {
      method: 'POST',
      headers: systemHeaders,
      body: JSON.stringify({
        organizationId: organization.id,
        onboardingId,
      }),
    }
  );

  if (!billingResponse.ok) {
    const errorBody = await billingResponse.text();
    console.error('Billing Service error:', {
      status: billingResponse.status,
      statusText: billingResponse.statusText,
      body: errorBody,
    });
    throw new Error(
      `Failed to create billing builder: ${billingResponse.status} ${errorBody}`
    );
  }

  return billingResponse.json();
};

const finalizeOrganizationStep = async (
  database: Database,
  onboardingId: string,
  updates: {
    betterAuthOrgId: string;
    billingBuilderId: string;
  }
) => {
  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 2,
    completedSteps: ['organization'],
    betterAuthOrgId: updates.betterAuthOrgId,
    billingBuilderId: updates.billingBuilderId,
  });
};

export const processOrganizationStep = async (
  database: Database,
  onboardingId: string,
  input: OrganizationStepInput,
  env: {
    BETTER_AUTH_SECRET: string;
    USER_SERVICE_URL: string;
    ORGANIZATION_SERVICE_URL?: string;
    BILLING_SERVICE_URL: string;
  }
) => {
  const systemHeaders = await createSystemHeaders(
    env.BETTER_AUTH_SECRET,
    'auth-service'
  );
  console.warn('[onboarding:org] Starting organization step', {
    onboardingId,
    orgServiceUrl: env.ORGANIZATION_SERVICE_URL,
    userServiceUrl: env.USER_SERVICE_URL,
    billingServiceUrl: env.BILLING_SERVICE_URL,
  });

  const authUser = await fetchUserFromBetterAuth(
    database,
    input.betterAuthUserId
  );
  console.warn('[onboarding:org] Auth user found:', {
    id: authUser.id,
    email: authUser.email,
  });

  let organization: any;
  try {
    organization = await createOrganizationViaService(env, systemHeaders, {
      betterAuthOrgId: input.betterAuthOrgId,
      organizationName: input.organizationName,
    });
    console.warn('[onboarding:org] Organization created:', organization);
  } catch (error) {
    console.error(
      '[onboarding:org] Failed to create org:',
      error instanceof Error ? error.message : error
    );
    throw error;
  }

  try {
    await ensureUserExistsInService(
      env,
      systemHeaders,
      authUser,
      organization,
      onboardingId
    );
    console.warn('[onboarding:org] User ensured in user service');
  } catch (error) {
    console.error(
      '[onboarding:org] Failed to ensure user:',
      error instanceof Error ? error.message : error
    );
    throw error;
  }

  let billingBuilder: any;
  try {
    billingBuilder = await createBillingBuilderForOrganization(
      env,
      systemHeaders,
      organization,
      onboardingId
    );
    console.warn('[onboarding:org] Billing builder created:', billingBuilder);
  } catch (error) {
    console.error(
      '[onboarding:org] Failed to create billing builder:',
      error instanceof Error ? error.message : error
    );
    throw error;
  }

  return finalizeOrganizationStep(database, onboardingId, {
    betterAuthOrgId: input.betterAuthOrgId,
    billingBuilderId: billingBuilder.id,
  });
};

export interface PlanStepInput {
  modules: { web: boolean; cctv: boolean; social: boolean };
  payAsYouGo: boolean;
  billingPeriod: 'monthly' | 'annual';
}

const validateOnboardingForPlanStep = async (
  database: Database,
  onboardingId: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');
  if (!onboarding.billingBuilderId)
    throw new Error('Billing builder not found');
  return onboarding;
};

const updateBillingBuilderWithPlan = async (
  billingServiceUrl: string,
  billingBuilderId: string,
  headers: Record<string, string>,
  planData: PlanStepInput
) => {
  const updateResponse = await fetch(
    `${billingServiceUrl}/api/v1/billing/billing-builders/${billingBuilderId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        modules: planData.modules,
        payAsYouGo: planData.payAsYouGo,
        billingPeriod: planData.billingPeriod,
      }),
    }
  );

  if (!updateResponse.ok) {
    throw new Error('Failed to update billing builder');
  }
};

export const processPlanStep = async (
  database: Database,
  onboardingId: string,
  input: PlanStepInput,
  billingServiceUrl: string,
  secret: string
) => {
  const onboarding = await validateOnboardingForPlanStep(
    database,
    onboardingId
  );
  console.warn('[onboarding:plan] Starting plan step', {
    onboardingId,
    billingBuilderId: onboarding.billingBuilderId,
    billingServiceUrl,
  });
  const headers = await createSystemHeaders(secret, 'auth-service');

  try {
    await updateBillingBuilderWithPlan(
      billingServiceUrl,
      onboarding.billingBuilderId!,
      headers,
      input
    );
    console.warn('[onboarding:plan] Billing builder updated');
  } catch (error) {
    console.error(
      '[onboarding:plan] Failed to update billing builder:',
      error instanceof Error ? error.message : error
    );
    throw error;
  }

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 3,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'modules'
    ),
  });
};

export interface ProductsStepInput {
  sourceType: 'csv' | 'json' | 'url';
  sourceValue: string;
  jobId?: string;
}

export const processProductsStep = async (
  database: Database,
  onboardingId: string,
  input: ProductsStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 4,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'products'
    ),
    productSource: {
      type: input.sourceType,
      value: input.sourceValue,
      jobId: input.jobId,
      status: 'pending',
    },
  });
};

export interface SourceStepInput {
  sourceType: 'web' | 'cctv' | 'social';
  apiKeyId: string;
}

const parseExistingSources = (sourcesJson: string | null) => {
  return JSON.parse(sourcesJson || '{}') as Record<
    string,
    { apiKeyId: string; connected: boolean }
  >;
};

export const processSourceStep = async (
  database: Database,
  onboardingId: string,
  input: SourceStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const sources = parseExistingSources(onboarding.sources);
  sources[input.sourceType] = { apiKeyId: input.apiKeyId, connected: true };

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 5,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'sources'
    ),
    sources: sources as typeof onboarding.sources,
  });
};

export const processCheckoutStep = async (
  database: Database,
  onboardingId: string,
  _stripeSessionId: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 4,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'checkout'
    ),
  });
};

export const processTeamStep = async (
  database: Database,
  onboardingId: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 6,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'team'
    ),
  });
};

export const completeOnboarding = async (
  database: Database,
  onboardingId: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    status: 'completed',
    completedAt: new Date(),
  });
};

export const getOnboardingStatus = async (
  database: Database,
  onboardingId: string
) => {
  return onboardingRepo.findOnboardingById(database, onboardingId);
};

export const getOnboardingByUserId = async (
  database: Database,
  betterAuthUserId: string
) => {
  return onboardingRepo.findOnboardingByUserId(database, betterAuthUserId);
};

const getStepNumberFromName = (step: string, currentStep: number): number => {
  const stepMap: Record<string, number> = {
    organization: 2,
    modules: 3,
    checkout: 4,
    products: 5,
    sources: 6,
  };
  return stepMap[step] || currentStep;
};

export const markStepCompleted = async (
  database: Database,
  onboardingId: string,
  step: string
): Promise<void> => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const completedSteps = appendStepToCompletedSteps(
    onboarding.completedSteps,
    step
  );
  const currentStep = getStepNumberFromName(step, onboarding.currentStep);

  await onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    completedSteps,
    currentStep,
  });
};

export const recordSourceConnection = async (
  database: Database,
  onboardingId: string,
  sourceType: string
): Promise<void> => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const sources = parseExistingSources(onboarding.sources);
  sources[sourceType] = { connected: true };

  await onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    sources: sources as typeof onboarding.sources,
  });
};
