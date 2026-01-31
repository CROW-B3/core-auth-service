import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';

export type Database = DrizzleD1Database<typeof schema>;

export const checkEmailIsOrgMember = async (
  database: Database,
  email: string,
  organizationId: string
): Promise<boolean> => {
  const userWithEmail = await database
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);

  if (userWithEmail.length === 0) {
    return false;
  }

  const userId = userWithEmail[0].id;

  const membership = await database
    .select()
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, userId),
        eq(schema.member.organizationId, organizationId)
      )
    )
    .limit(1);

  return membership.length > 0;
};

export const checkPendingInvitation = async (
  database: Database,
  email: string,
  organizationId: string
): Promise<boolean> => {
  const pendingInvitation = await database
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email),
        eq(schema.invitation.organizationId, organizationId),
        eq(schema.invitation.status, 'pending')
      )
    )
    .limit(1);

  return pendingInvitation.length > 0;
};

export const createInvitation = async (
  database: Database,
  organizationId: string,
  email: string,
  inviterId: string
): Promise<string> => {
  const invitationId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await database.insert(schema.invitation).values({
    id: invitationId,
    organizationId,
    email,
    role: 'member',
    status: 'pending',
    expiresAt,
    inviterId,
    createdAt: now,
  });

  return invitationId;
};

export const addMemberToOrganization = async (
  database: Database,
  organizationId: string,
  userId: string
): Promise<void> => {
  const memberId = crypto.randomUUID();
  const now = new Date();

  await database.insert(schema.member).values({
    id: memberId,
    organizationId,
    userId,
    role: 'member',
    createdAt: now,
  });
};

export const getUserIdByEmail = async (
  database: Database,
  email: string
): Promise<string | null> => {
  const users = await database
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);

  return users.length > 0 ? users[0].id : null;
};
