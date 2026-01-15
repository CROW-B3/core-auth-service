import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
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

export const findOnboardingById = async (db: Database, id: string) => {
  const result = await db
    .select()
    .from(schema.onboarding)
    .where(eq(schema.onboarding.id, id))
    .limit(1);
  return result[0] ?? null;
};

export const createOnboardingRecord = async (
  db: Database,
  input: CreateOnboardingInput
) => {
  const now = new Date();
  await db.insert(schema.onboarding).values({
    id: input.id,
    betterAuthUserId: input.betterAuthUserId,
    createdAt: now,
  });
  return findOnboardingById(db, input.id);
};

export const findOnboardingByUserId = async (
  db: Database,
  betterAuthUserId: string
) => {
  const result = await db
    .select()
    .from(schema.onboarding)
    .where(eq(schema.onboarding.betterAuthUserId, betterAuthUserId))
    .limit(1);
  return result[0] ?? null;
};

export const findActiveOnboardingByUserId = async (
  db: Database,
  betterAuthUserId: string
) => {
  const result = await db
    .select()
    .from(schema.onboarding)
    .where(eq(schema.onboarding.betterAuthUserId, betterAuthUserId))
    .limit(1);
  const onboarding = result[0];
  if (!onboarding || onboarding.status !== 'in_progress') return null;
  return onboarding;
};

export const updateOnboardingRecord = async (
  db: Database,
  id: string,
  input: UpdateOnboardingInput
) => {
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

  await db
    .update(schema.onboarding)
    .set(updateData)
    .where(eq(schema.onboarding.id, id));

  return findOnboardingById(db, id);
};

export const deleteOnboardingRecord = async (db: Database, id: string) => {
  await db.delete(schema.onboarding).where(eq(schema.onboarding.id, id));
};
