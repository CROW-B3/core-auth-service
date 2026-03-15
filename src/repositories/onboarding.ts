import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';

type Database = DrizzleD1Database<typeof schema>;

export interface CreateOnboardingInput {
  id: string;
  betterAuthUserId: string;
}

export interface UpdateOnboardingInput {
  betterAuthOrgId?: string;
  orgBuilderId?: string;
  userBuilderId?: string;
  billingBuilderId?: string;
  currentStep?: number;
  completedSteps?: string[];
  productSource?: {
    type: 'csv' | 'json' | 'url';
    value: string;
    jobId?: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
  };
  sources?: {
    web?: { apiKeyId: string; connected: boolean };
    cctv?: { apiKeyId: string; connected: boolean };
    social?: { apiKeyId: string; connected: boolean };
  };
  status?: 'in_progress' | 'completed' | 'abandoned';
  completedAt?: Date;
}

export const findOnboardingById = async (database: Database, id: string) => {
  const results = await database
    .select()
    .from(schema.onboarding)
    .where(eq(schema.onboarding.id, id))
    .limit(1);
  return results[0] ?? null;
};

export const createOnboardingRecord = async (
  database: Database,
  input: CreateOnboardingInput
) => {
  const timestamp = Math.floor(Date.now() / 1000);

  await database.run(
    sql.raw(`
    INSERT INTO onboarding (
      id, betterAuthUserId, betterAuthOrgId, orgBuilderId, userBuilderId,
      billingBuilderId, currentStep, completedSteps, productSource, sources,
      status, createdAt, completedAt
    ) VALUES (
      '${input.id}', '${input.betterAuthUserId}', NULL, NULL, NULL,
      NULL, 1, '[]', NULL, '{}',
      'in_progress', ${timestamp}, NULL
    )
  `)
  );

  return findOnboardingById(database, input.id);
};

export const findOnboardingByUserId = async (
  database: Database,
  betterAuthUserId: string
) => {
  const results = await database
    .select()
    .from(schema.onboarding)
    .where(eq(schema.onboarding.betterAuthUserId, betterAuthUserId))
    .limit(1);
  return results[0] ?? null;
};

const isOnboardingActive = (
  onboarding: typeof schema.onboarding.$inferSelect | null
) => {
  return onboarding?.status === 'in_progress';
};

export const findActiveOnboardingByUserId = async (
  database: Database,
  betterAuthUserId: string
) => {
  const onboarding = await findOnboardingByUserId(database, betterAuthUserId);
  if (!isOnboardingActive(onboarding)) return null;
  return onboarding;
};

const buildUpdateDataObject = (
  input: UpdateOnboardingInput
): Record<string, unknown> => {
  const updateData: Record<string, unknown> = {};

  if (input.betterAuthOrgId !== undefined)
    updateData.betterAuthOrgId = input.betterAuthOrgId;
  if (input.orgBuilderId !== undefined)
    updateData.orgBuilderId = input.orgBuilderId;
  if (input.userBuilderId !== undefined)
    updateData.userBuilderId = input.userBuilderId;
  if (input.billingBuilderId !== undefined)
    updateData.billingBuilderId = input.billingBuilderId;
  if (input.currentStep !== undefined)
    updateData.currentStep = input.currentStep;
  if (input.completedSteps !== undefined)
    updateData.completedSteps = JSON.stringify(input.completedSteps);
  if (input.productSource !== undefined)
    updateData.productSource = JSON.stringify(input.productSource);
  if (input.sources !== undefined)
    updateData.sources = JSON.stringify(input.sources);
  if (input.status !== undefined) updateData.status = input.status;
  if (input.completedAt !== undefined)
    updateData.completedAt = input.completedAt;

  return updateData;
};

export const updateOnboardingRecord = async (
  database: Database,
  id: string,
  input: UpdateOnboardingInput
) => {
  const updateData = buildUpdateDataObject(input);

  await database
    .update(schema.onboarding)
    .set(updateData)
    .where(eq(schema.onboarding.id, id));

  return findOnboardingById(database, id);
};

export const deleteOnboardingRecord = async (
  database: Database,
  id: string
) => {
  await database.delete(schema.onboarding).where(eq(schema.onboarding.id, id));
};
