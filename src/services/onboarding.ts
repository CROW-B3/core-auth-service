import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../db/schema';
import type { Environment } from '../types';
import * as onboardingRepo from '../repositories/onboarding';

type Database = DrizzleD1Database<typeof schema>;

interface ServiceUrls {
  orgService: string;
  userService: string;
  billingService: string;
  productService: string;
}

const getServiceUrls = (env: Environment): ServiceUrls => {
  if (env.ENVIRONMENT === 'local') {
    return {
      orgService: 'http://localhost:8004',
      userService: 'http://localhost:8002',
      billingService: 'http://localhost:8012',
      productService: 'http://localhost:8003',
    };
  }
  if (env.ENVIRONMENT === 'dev') {
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

const createOrgBuilder = async (
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

const createUserBuilder = async (
  serviceUrl: string,
  betterAuthUserId: string,
  organizationId: string
) => {
  const defaultOwnerPermissions = {
    chat: {
      enabled: true,
      components: ['web', 'cctv', 'social'],
      lookbackWindow: 'all',
    },
    interactions: true,
    patterns: true,
    teamManagement: true,
    apiKeyManagement: true,
  };

  const response = await fetch(`${serviceUrl}/api/v1/user-builders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      betterAuthUserId,
      organizationId,
      permissions: defaultOwnerPermissions,
    }),
  });
  if (!response.ok) throw new Error('Failed to create user builder');
  return response.json();
};

const createBillingBuilder = async (
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

const appendToCompletedSteps = (
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
  db: Database,
  env: Environment,
  betterAuthUserId: string
): Promise<StartOnboardingResult> => {
  const serviceUrls = getServiceUrls(env);

  const existingUserResponse = await fetch(
    `${serviceUrls.userService}/api/v1/users/by-auth-id/${betterAuthUserId}`
  );

  if (existingUserResponse.ok) {
    const existingUser = await existingUserResponse.json();
    if (existingUser.organizationId)
      return { onboarding: null as never, redirect: '/dashboard' };
  }

  const existingOnboarding = await onboardingRepo.findActiveOnboardingByUserId(
    db,
    betterAuthUserId
  );
  if (existingOnboarding) return { onboarding: existingOnboarding };

  const onboardingId = crypto.randomUUID();
  const onboarding = await onboardingRepo.createOnboardingRecord(db, {
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
  db: Database,
  env: Environment,
  onboardingId: string,
  betterAuthOrgId: string,
  betterAuthUserId: string,
  input: OrganizationStepInput
) => {
  const serviceUrls = getServiceUrls(env);

  const orgBuilder = await createOrgBuilder(
    serviceUrls.orgService,
    betterAuthOrgId,
    input.organizationName
  );

  const userBuilder = await createUserBuilder(
    serviceUrls.userService,
    betterAuthUserId,
    orgBuilder.id
  );

  const billingBuilder = await createBillingBuilder(
    serviceUrls.billingService,
    orgBuilder.id
  );

  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
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

export const processPlanStep = async (
  db: Database,
  env: Environment,
  onboardingId: string,
  input: PlanStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(db, onboardingId);
  if (!onboarding) throw new Error('Onboarding not found');

  const serviceUrls = getServiceUrls(env);

  await fetch(
    `${serviceUrls.billingService}/api/v1/billing-builders/${onboarding.billingBuilderId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modules: input.modules,
        payAsYouGo: input.payAsYouGo,
        billingPeriod: input.billingPeriod,
      }),
    }
  );

  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
    currentStep: 3,
    completedSteps: appendToCompletedSteps(onboarding.completedSteps, 'plan'),
  });
};

export interface ProductsStepInput {
  sourceType: 'csv' | 'json' | 'url';
  sourceValue: string;
}

const createCrawlerJob = async (
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
  db: Database,
  env: Environment,
  onboardingId: string,
  input: ProductsStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(db, onboardingId);
  if (!onboarding) throw new Error('Onboarding not found');

  const serviceUrls = getServiceUrls(env);

  const job = await createCrawlerJob(
    serviceUrls.productService,
    onboarding.orgBuilderId!,
    onboardingId,
    input
  );

  await env.PRODUCT_CRAWL_QUEUE.send({
    jobId: job.id,
    organizationId: onboarding.orgBuilderId!,
    url: input.sourceValue,
  });

  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
    currentStep: 4,
    completedSteps: appendToCompletedSteps(
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

export const processSourceStep = async (
  db: Database,
  onboardingId: string,
  input: SourceStepInput
) => {
  const onboarding = await onboardingRepo.findOnboardingById(db, onboardingId);
  if (!onboarding) throw new Error('Onboarding not found');

  const sources = JSON.parse(onboarding.sources || '{}') as Record<
    string,
    { apiKeyId: string; connected: boolean }
  >;
  sources[input.sourceType] = { apiKeyId: input.apiKeyId, connected: true };

  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
    currentStep: 5,
    completedSteps: appendToCompletedSteps(
      onboarding.completedSteps,
      'sources'
    ),
    sources: sources as typeof onboarding.sources,
  });
};

export const processTeamStep = async (db: Database, onboardingId: string) => {
  const onboarding = await onboardingRepo.findOnboardingById(db, onboardingId);
  if (!onboarding) throw new Error('Onboarding not found');

  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
    currentStep: 6,
    completedSteps: appendToCompletedSteps(onboarding.completedSteps, 'team'),
  });
};

export const completeOnboarding = async (
  db: Database,
  onboardingId: string
) => {
  return onboardingRepo.updateOnboardingRecord(db, onboardingId, {
    status: 'completed',
    completedAt: new Date(),
  });
};

export const getOnboardingStatus = async (
  db: Database,
  onboardingId: string
) => {
  return onboardingRepo.findOnboardingById(db, onboardingId);
};

export const getOnboardingByUserId = async (
  db: Database,
  betterAuthUserId: string
) => {
  return onboardingRepo.findOnboardingByUserId(db, betterAuthUserId);
};
