import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../db/schema';
import * as onboardingRepo from '../repositories/onboarding';
import { createSystemHeaders } from '../lib/system-jwt';

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
  betterAuthOrgId?: string | null;
  orgBuilderId?: string | null;
  userBuilderId?: string | null;
  billingBuilderId?: string | null;
}

export const processOrganizationStep = async (
  database: Database,
  onboardingId: string,
  input: OrganizationStepInput
) => {
  const updateData: Parameters<typeof onboardingRepo.updateOnboardingRecord>[2] = {
    currentStep: 2,
    completedSteps: ['organization'],
  };

  // Only include IDs if they're truthy values (not null/undefined/'null')
  if (input.betterAuthOrgId && input.betterAuthOrgId !== 'null') {
    updateData.betterAuthOrgId = input.betterAuthOrgId;
  }
  if (input.orgBuilderId && input.orgBuilderId !== 'null') {
    updateData.orgBuilderId = input.orgBuilderId;
  }
  if (input.userBuilderId && input.userBuilderId !== 'null') {
    updateData.userBuilderId = input.userBuilderId;
  }
  if (input.billingBuilderId && input.billingBuilderId !== 'null') {
    updateData.billingBuilderId = input.billingBuilderId;
  }

  return onboardingRepo.updateOnboardingRecord(database, onboardingId, updateData);
};

export interface PlanStepInput {
  modules: { web: boolean; cctv: boolean; social: boolean };
  payAsYouGo: boolean;
  billingPeriod: 'monthly' | 'annual';
}

export const processPlanStep = async (
  database: Database,
  onboardingId: string,
  input: PlanStepInput,
  billingServiceUrl: string,
  secret: string
) => {
  const onboarding = await onboardingRepo.findOnboardingById(
    database,
    onboardingId
  );
  if (!onboarding) throw new Error('Onboarding not found');

  if (!onboarding.billingBuilderId) {
    throw new Error('Billing builder not found');
  }

  // Generate system JWT headers for service-to-service authentication
  const headers = await createSystemHeaders(secret, 'auth-service');

  // Update billing builder with selected modules
  const updateResponse = await fetch(
    `${billingServiceUrl}/api/v1/billing/billing-builders/${onboarding.billingBuilderId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        modules: input.modules,
        payAsYouGo: input.payAsYouGo,
        billingPeriod: input.billingPeriod,
      }),
    }
  );

  if (!updateResponse.ok) {
    throw new Error('Failed to update billing builder');
  }

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
