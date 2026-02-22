import type { Environment } from '../types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { z } from 'zod';
import * as schema from '../db/schema';
import { createSystemHeaders } from '../lib/system-jwt';
import {
  addMemberToOrganization,
  checkEmailIsOrgMember,
  checkPendingInvitation,
  createInvitation,
  getUserIdByEmail,
} from '../services/invitation-service';

const INVITATION_SCHEMA = z.object({
  emails: z.array(z.string().email()),
  organizationId: z.string(),
  organizationName: z.string(),
  inviterName: z.string(),
  inviterId: z.string(),
  permissions: z.any().optional(),
});

type InvitationRequest = z.infer<typeof INVITATION_SCHEMA>;

interface ValidationResult {
  email: string;
  status: 'already_member' | 'pending_invite' | 'existing_user' | 'new_user';
  userId?: string;
}

interface InvitationResult {
  email: string;
  messageId?: string;
  error?: string;
  status: string;
}

const teamInvitationRoutes = new Hono<{ Bindings: Environment }>();

const parseInvitationRequest = async (
  context: any
): Promise<InvitationRequest> => {
  const rawBody = await context.req.json();
  return INVITATION_SCHEMA.parse(rawBody);
};

const buildInviteLink = (
  baseUrl: string,
  organizationId: string,
  organizationName: string,
  email: string
): string => {
  return `${baseUrl}/accept-invite?org=${organizationId}&email=${encodeURIComponent(email)}&orgName=${encodeURIComponent(organizationName)}`;
};

const buildDashboardLink = (baseUrl: string): string => {
  return baseUrl;
};

const validateEmail = async (
  database: any,
  userServiceUrl: string,
  email: string,
  organizationId: string,
  secret: string
): Promise<ValidationResult> => {
  const isAlreadyMember = await checkEmailIsOrgMember(
    database,
    email,
    organizationId
  );

  if (isAlreadyMember) {
    return { email, status: 'already_member' };
  }

  const hasPendingInvite = await checkPendingInvitation(
    database,
    email,
    organizationId
  );

  if (hasPendingInvite) {
    return { email, status: 'pending_invite' };
  }

  const systemHeaders = await createSystemHeaders(secret, 'auth-service');
  const response = await fetch(`${userServiceUrl}/api/v1/users/check-emails`, {
    method: 'POST',
    headers: systemHeaders,
    body: JSON.stringify({
      emails: [email],
      organizationId,
    }),
  });

  const existingResult = (await response.json()) as {
    existingEmails?: string[];
  };
  const existingEmails: string[] = Array.isArray(existingResult.existingEmails)
    ? existingResult.existingEmails
    : [];
  const existsInUserService = existingEmails.includes(email);

  if (existsInUserService) {
    const userId = await getUserIdByEmail(database, email);
    return { email, status: 'existing_user', userId: userId || undefined };
  }

  return { email, status: 'new_user' };
};

const sendInvitationEmail = async (
  notificationServiceUrl: string,
  email: string,
  organizationName: string,
  inviterName: string,
  inviteLink: string,
  secret: string
): Promise<InvitationResult> => {
  try {
    const systemHeaders = await createSystemHeaders(secret, 'auth-service');
    const response = await fetch(
      `${notificationServiceUrl}/api/v1/notifications/email`,
      {
        method: 'POST',
        headers: systemHeaders,
        body: JSON.stringify({
          to: email,
          subject: `You've been invited to join ${organizationName}`,
          html: `<p>${inviterName} has invited you to join <strong>${organizationName}</strong>.</p><p><a href="${inviteLink}">Accept Invitation</a></p>`,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      return { email, error: errorData, status: 'failed' };
    }

    const result = (await response.json()) as { messageId?: string };
    return { email, messageId: result.messageId, status: 'invited' };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    return { email, error: errorMessage, status: 'failed' };
  }
};

const sendAddedEmail = async (
  notificationServiceUrl: string,
  email: string,
  organizationName: string,
  inviterName: string,
  dashboardLink: string,
  secret: string
): Promise<InvitationResult> => {
  try {
    const systemHeaders = await createSystemHeaders(secret, 'auth-service');
    const response = await fetch(
      `${notificationServiceUrl}/api/v1/notifications/email`,
      {
        method: 'POST',
        headers: systemHeaders,
        body: JSON.stringify({
          to: email,
          subject: `You've been added to ${organizationName}`,
          html: `<p>${inviterName} has added you to <strong>${organizationName}</strong>.</p><p><a href="${dashboardLink}">Go to Dashboard</a></p>`,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      return { email, error: errorData, status: 'failed' };
    }

    const result = (await response.json()) as { messageId?: string };
    return { email, messageId: result.messageId, status: 'added' };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    return { email, error: errorMessage, status: 'failed' };
  }
};

const processEmail = async (
  database: any,
  notificationServiceUrl: string,
  userServiceUrl: string,
  authClientUrl: string,
  dashboardUrl: string,
  invitationData: InvitationRequest,
  email: string,
  secret: string
): Promise<InvitationResult> => {
  const validation = await validateEmail(
    database,
    userServiceUrl,
    email,
    invitationData.organizationId,
    secret
  );

  if (validation.status === 'already_member') {
    return {
      email,
      status: 'already_member',
      error: 'User is already a member',
    };
  }

  if (validation.status === 'pending_invite') {
    return {
      email,
      status: 'pending_invite',
      error: 'Invitation already pending',
    };
  }

  if (validation.status === 'existing_user' && validation.userId) {
    await addMemberToOrganization(
      database,
      invitationData.organizationId,
      validation.userId
    );

    const dashboardLink = buildDashboardLink(dashboardUrl);

    return sendAddedEmail(
      notificationServiceUrl,
      email,
      invitationData.organizationName,
      invitationData.inviterName,
      dashboardLink,
      secret
    );
  }

  await createInvitation(
    database,
    invitationData.organizationId,
    email,
    invitationData.inviterId
  );

  const inviteLink = buildInviteLink(
    authClientUrl,
    invitationData.organizationId,
    invitationData.organizationName,
    email
  );

  return sendInvitationEmail(
    notificationServiceUrl,
    email,
    invitationData.organizationName,
    invitationData.inviterName,
    inviteLink,
    secret
  );
};

const processAllEmails = async (
  database: any,
  notificationServiceUrl: string,
  userServiceUrl: string,
  authClientUrl: string,
  dashboardUrl: string,
  invitationData: InvitationRequest,
  secret: string
): Promise<{ results: InvitationResult[]; errors: InvitationResult[] }> => {
  const results: InvitationResult[] = [];
  const errors: InvitationResult[] = [];

  for (const email of invitationData.emails) {
    const result = await processEmail(
      database,
      notificationServiceUrl,
      userServiceUrl,
      authClientUrl,
      dashboardUrl,
      invitationData,
      email,
      secret
    );

    if (result.error) {
      errors.push(result);
    } else {
      results.push(result);
    }
  }

  return { results, errors };
};

teamInvitationRoutes.post('/send-invites', async context => {
  let invitationData: InvitationRequest;

  try {
    invitationData = await parseInvitationRequest(context);
  } catch (error) {
    console.error('[TEAM-INVITATIONS] Validation error:', error);
    return context.json(
      {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      400
    );
  }

  const notificationServiceUrl = context.env.NOTIFICATION_SERVICE_URL;
  const userServiceUrl = context.env.USER_SERVICE_URL;
  const dashboardUrl = context.env.DASHBOARD_URL;

  if (!notificationServiceUrl || !userServiceUrl || !dashboardUrl) {
    return context.json({ error: 'Required services not configured' }, 500);
  }

  const database = drizzle(context.env.DB, { schema });

  const { results, errors } = await processAllEmails(
    database,
    notificationServiceUrl,
    userServiceUrl,
    context.env.AUTH_CLIENT_URL,
    dashboardUrl,
    invitationData,
    context.env.BETTER_AUTH_SECRET
  );

  return context.json({
    success: errors.length === 0,
    sent: results.length,
    failed: errors.length,
    results,
    errors,
  });
});

teamInvitationRoutes.get('/list-invitations', async context => {
  const organizationId = context.req.query('organizationId');

  if (!organizationId) {
    return context.json(
      { error: 'organizationId query parameter is required' },
      400
    );
  }

  const database = drizzle(context.env.DB, { schema });

  const invitations = await database
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
      createdAt: schema.invitation.createdAt,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.organizationId, organizationId));

  return context.json({ invitations });
});

export default teamInvitationRoutes;
