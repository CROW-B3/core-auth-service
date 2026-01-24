import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Environment } from '../types';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import * as onboardingRepo from '../repositories/onboarding';

type Database = DrizzleD1Database<typeof schema>;

interface ServiceUrls {
  orgService: string;
  userService: string;
  billingService: string;
  productService: string;
}

const getServiceUrlsForEnvironment = (
  environment: Environment
): ServiceUrls => {
  if (environment.ENVIRONMENT === 'local') {
    return {
      orgService: 'http://localhost:8004',
      userService: 'http://localhost:8002',
      billingService: 'http://localhost:8012',
      productService: 'http://localhost:8003',
    };
  }
  if (environment.ENVIRONMENT === 'dev') {
    return {
      orgService: 'https://dev.internal.organizations.crowai.dev',
      userService: 'https://dev.internal.users.crowai.dev',
      billingService: 'https://dev.internal.billing.crowai.dev',
      productService: 'https://dev.internal.products.crowai.dev',
    };
  }
  return {
    orgService: 'https://internal.organizations.crowai.dev',
    userService: 'https://internal.users.crowai.dev',
    billingService: 'https://internal.billing.crowai.dev',
    productService: 'https://internal.products.crowai.dev',
  };
};

const createOrgBuilderViaService = async (
  serviceUrl: string,
  betterAuthOrgId: string,
  organizationName: string
) => {
  const response = await fetch(`${serviceUrl}/api/v1/org-builders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ betterAuthOrgId, name: organizationName }),
  });
  if (!response.ok) throw new Error('Failed to create org builder');
  return response.json();
};

const getDefaultOwnerPermissions = () => ({
  chat: {
    enabled: true,
    components: ['web', 'cctv', 'social'],
    lookbackWindow: 'all',
  },
  interactions: true,
  patterns: true,
  teamManagement: true,
  apiKeyManagement: true,
});

const createUserBuilderViaService = async (
  serviceUrl: string,
  betterAuthUserId: string,
  organizationId: string
) => {
  const response = await fetch(`${serviceUrl}/api/v1/user-builders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      betterAuthUserId,
      organizationId,
      permissions: getDefaultOwnerPermissions(),
    }),
  });
  if (!response.ok) throw new Error('Failed to create user builder');
  return response.json();
};

const createBillingBuilderViaService = async (
  serviceUrl: string,
  organizationId: string
) => {
  const response = await fetch(`${serviceUrl}/api/v1/billing-builders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });
  if (!response.ok) throw new Error('Failed to create billing builder');
  return response.json();
};

const appendStepToCompletedSteps = (
  existingSteps: string | null,
  newStep: string
): string[] => {
  const steps = JSON.parse(existingSteps || '[]') as string[];
  if (!steps.includes(newStep)) steps.push(newStep);
  return steps;
};

const fetchExistingUserFromService = async (
  serviceUrl: string,
  betterAuthUserId: string
) => {
  const response = await fetch(`${serviceUrl}/by-auth-id/${betterAuthUserId}`);
  if (!response.ok) return null;
  return response.json();
};

export interface StartOnboardingResult {
  onboarding: typeof schema.onboarding.$inferSelect;
  redirect?: string;
}

export const startOnboarding = async (
  database: Database,
  environment: Environment,
  betterAuthUserId: string
): Promise<StartOnboardingResult> => {
  const serviceUrls = getServiceUrlsForEnvironment(environment);

  // First check if user already has an organization via user service
  const existingUser = await fetchExistingUserFromService(
    `${serviceUrls.userService}/api/v1/users`,
    betterAuthUserId
  );

  if (existingUser?.organizationId) {
    return { onboarding: null as never, redirect: '/dashboard' };
  }

  // Check for ANY existing onboarding (not just active)
  const existingOnboarding = await onboardingRepo.findOnboardingByUserId(
    database,
    betterAuthUserId
  );

  if (existingOnboarding) {
    // If onboarding is completed, redirect to dashboard
    if (existingOnboarding.status === 'completed') {
      return { onboarding: null as never, redirect: '/dashboard' };
    }

    // If onboarding is in_progress, return it to continue
    if (existingOnboarding.status === 'in_progress') {
      return { onboarding: existingOnboarding };
    }

    // If abandoned, we could either resume or create new - let's create new
    // (delete the abandoned one first)
    await onboardingRepo.deleteOnboardingRecord(
      database,
      existingOnboarding.id
    );
  }

  // No onboarding exists or was abandoned, create new
  const onboardingId = crypto.randomUUID();
  const onboarding = await onboardingRepo.createOnboardingRecord(database, {
    id: onboardingId,
    betterAuthUserId,
  });

  return { onboarding: onboarding! };
};

export interface OrganizationStepInput {
  organizationName: string;
  slug: string;
}

export const processOrganizationStep = async (
  database: Database,
  environment: Environment,
  onboardingId: string,
  betterAuthOrgId: string,
  betterAuthUserId: string,
  input: OrganizationStepInput
) => {
  const serviceUrls = getServiceUrlsForEnvironment(environment);

  const orgBuilder = await createOrgBuilderViaService(
    serviceUrls.orgService,
    betterAuthOrgId,
    input.organizationName
  );

  const userBuilder = await createUserBuilderViaService(
    serviceUrls.userService,
    betterAuthUserId,
    orgBuilder.id
  );

  const billingBuilder = await createBillingBuilderViaService(
    serviceUrls.billingService,
    orgBuilder.id
  );

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    betterAuthOrgId,
    orgBuilderId: orgBuilder.id,
    userBuilderId: userBuilder.id,
    billingBuilderId: billingBuilder.id,
    currentStep: 2,
    completedSteps: ['organization'],
  });
};

export interface PlanStepInput {
  modules: { web: boolean; cctv: boolean; social: boolean };
  payAsYouGo: boolean;
  billingPeriod: 'monthly' | 'annual';
}

const updateBillingBuilderViService = async (
  serviceUrl: string,
  billingBuilderId: string,
  input: PlanStepInput
) => {
  await fetch(`${serviceUrl}/api/v1/billing-builders/${billingBuilderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modules: input.modules,
      payAsYouGo: input.payAsYouGo,
      billingPeriod: input.billingPeriod,
    }),
  });
};

export const processPlanStep = async (
  database: Database,
  environment: Environment,
  onboardingId: string,
  input: PlanStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const serviceUrls = getServiceUrlsForEnvironment(environment);

  await updateBillingBuilderViService(
    serviceUrls.billingService,
    onboarding.billingBuilderId!,
    input
  );

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 3,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'plan'
    ),
  });
};

export interface ProductsStepInput {
  sourceType: 'csv' | 'json' | 'url';
  sourceValue: string;
}

const createCrawlerJobViaService = async (
  serviceUrl: string,
  organizationId: string,
  onboardingId: string,
  input: ProductsStepInput
): Promise<{ id: string }> => {
  const response = await fetch(`${serviceUrl}/api/v1/crawler-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      onboardingId,
      sourceType: input.sourceType,
      sourceValue: input.sourceValue,
    }),
  });
  if (!response.ok) throw new Error('Failed to create crawler job');
  return response.json();
};

export const processProductsStep = async (
  database: Database,
  environment: Environment,
  onboardingId: string,
  input: ProductsStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const serviceUrls = getServiceUrlsForEnvironment(environment);

  const job = await createCrawlerJobViaService(
    serviceUrls.productService,
    onboarding.orgBuilderId!,
    onboardingId,
    input
  );

  await environment.PRODUCT_CRAWL_QUEUE.send({
    jobId: job.id,
    organizationId: onboarding.orgBuilderId!,
    url: input.sourceValue,
  });

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, {
    currentStep: 4,
    completedSteps: appendStepToCompletedSteps(
      onboarding.completedSteps,
      'products'
    ),
    productSource: {
      type: input.sourceType,
      value: input.sourceValue,
      jobId: job.id,
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

const finalizeOrgBuilderViaService = async (
  serviceUrl: string,
  orgBuilderId: string,
  slug: string
) => {
  const response = await fetch(
    `${serviceUrl}/api/v1/org-builders/${orgBuilderId}/finalize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    }
  );
  if (!response.ok) throw new Error('Failed to finalize org builder');
  return response.json();
};

const finalizeUserBuilderViaService = async (
  serviceUrl: string,
  userBuilderId: string,
  email: string,
  name: string,
  role: 'owner' | 'admin' | 'member'
) => {
  const response = await fetch(
    `${serviceUrl}/api/v1/user-builders/${userBuilderId}/finalize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, role }),
    }
  );
  if (!response.ok) throw new Error('Failed to finalize user builder');
  return response.json();
};

const getBetterAuthUserById = async (database: Database, userId: string) => {
  const results = await database
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return results[0] ?? null;
};

const getBetterAuthOrgById = async (database: Database, orgId: string) => {
  const results = await database
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return results[0] ?? null;
};

export const completeOnboarding = async (
  database: Database,
  environment: Environment,
  onboardingId: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  const serviceUrls = getServiceUrlsForEnvironment(environment);

  const betterAuthUser = await getBetterAuthUserById(
    database,
    onboarding.betterAuthUserId
  );
  if (!betterAuthUser) throw new Error('User not found');

  if (onboarding.orgBuilderId && onboarding.betterAuthOrgId) {
    const betterAuthOrg = await getBetterAuthOrgById(
      database,
      onboarding.betterAuthOrgId
    );

    if (betterAuthOrg) {
      await finalizeOrgBuilderViaService(
        serviceUrls.orgService,
        onboarding.orgBuilderId,
        betterAuthOrg.slug
      );
    }
  }

  if (onboarding.userBuilderId) {
    await finalizeUserBuilderViaService(
      serviceUrls.userService,
      onboarding.userBuilderId,
      betterAuthUser.email,
      betterAuthUser.name,
      'owner'
    );
  }

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
