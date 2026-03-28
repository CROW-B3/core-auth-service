import type { Environment } from '../types';
import { and, eq } from 'drizzle-orm';

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

const AMPERSAND_REGEX = /&/g;
const LESS_THAN_REGEX = /</g;
const GREATER_THAN_REGEX = />/g;
const DOUBLE_QUOTE_REGEX = /"/g;
const SINGLE_QUOTE_REGEX = /'/g;

const escapeHtml = (str: string): string =>
  str
    .replace(AMPERSAND_REGEX, '&amp;')
    .replace(LESS_THAN_REGEX, '&lt;')
    .replace(GREATER_THAN_REGEX, '&gt;')
    .replace(DOUBLE_QUOTE_REGEX, '&quot;')
    .replace(SINGLE_QUOTE_REGEX, '&#x27;');

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
  if (!rawBody.inviterId) {
    const headerInviterId =
      context.req.header('X-User-Id') ?? context.req.header('X-Caller-Id');
    if (headerInviterId) rawBody.inviterId = headerInviterId;
  }
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
          html: `<p>${escapeHtml(inviterName)} has invited you to join <strong>${escapeHtml(organizationName)}</strong>.</p><p><a href="${escapeHtml(inviteLink)}">Accept Invitation</a></p>`,
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
          html: `<p>${escapeHtml(inviterName)} has added you to <strong>${escapeHtml(organizationName)}</strong>.</p><p><a href="${escapeHtml(dashboardLink)}">Go to Dashboard</a></p>`,
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

const parseSendInvitesBody = async (
  context: any
): Promise<InvitationRequest | Response> => {
  try {
    return await parseInvitationRequest(context);
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
};

const verifyInviterMembership = async (
  database: any,
  inviterId: string,
  organizationId: string
): Promise<{ id: string; role: string } | undefined> => {
  return database
    .select({ id: schema.member.id, role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, inviterId),
        eq(schema.member.organizationId, organizationId)
      )
    )
    .get();
};

const checkInviterPermissions = (
  context: any,
  membership: { id: string; role: string } | undefined
): Response | null => {
  if (!membership) {
    return context.json(
      {
        error: 'Forbidden',
        message: 'You are not a member of this organization',
      },
      403
    );
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return context.json(
      {
        error: 'Forbidden',
        message: 'Insufficient permissions to invite members',
      },
      403
    );
  }

  return null;
};

teamInvitationRoutes.post('/send-invites', async context => {
  const parsed = await parseSendInvitesBody(context);
  if (parsed instanceof Response) return parsed;

  const invitationData = parsed;
  const database = drizzle(context.env.DB, { schema });

  const membership = await verifyInviterMembership(
    database,
    invitationData.inviterId,
    invitationData.organizationId
  );
  const permissionError = checkInviterPermissions(context, membership);
  if (permissionError) return permissionError;

  const notificationServiceUrl = context.env.NOTIFICATION_SERVICE_URL;
  const userServiceUrl = context.env.USER_SERVICE_URL;
  const dashboardUrl = context.env.DASHBOARD_URL;

  if (!notificationServiceUrl || !userServiceUrl || !dashboardUrl) {
    return context.json({ error: 'Required services not configured' }, 500);
  }

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

const extractCallerId = (context: any): string =>
  context.req.header('X-User-Id') ?? context.req.header('X-Caller-Id') ?? '';

const verifyCallerMembership = async (
  database: any,
  callerId: string,
  organizationId: string
): Promise<{ id: string } | undefined> => {
  return database
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, callerId),
        eq(schema.member.organizationId, organizationId)
      )
    )
    .get();
};

const fetchInvitationsForOrg = async (
  database: any,
  organizationId: string
) => {
  return database
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
};

teamInvitationRoutes.get('/list-invitations', async context => {
  const organizationId = context.req.query('organizationId');
  const callerId = extractCallerId(context);

  if (!organizationId) {
    return context.json(
      { error: 'organizationId query parameter is required' },
      400
    );
  }

  if (!callerId) {
    return context.json(
      { error: 'Unauthorized', message: 'Authentication required' },
      401
    );
  }

  const database = drizzle(context.env.DB, { schema });
  const callerMembership = await verifyCallerMembership(
    database,
    callerId,
    organizationId
  );

  if (!callerMembership) {
    return context.json(
      { error: 'Forbidden', message: 'Access denied to this organization' },
      403
    );
  }

  const invitations = await fetchInvitationsForOrg(database, organizationId);
  return context.json({ invitations });
});

const findInvitationById = async (
  database: any,
  invitationId: string
): Promise<{ id: string; organizationId: string } | undefined> => {
  return database
    .select({
      id: schema.invitation.id,
      organizationId: schema.invitation.organizationId,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, invitationId))
    .get();
};

const verifyCallerAdminRole = async (
  database: any,
  callerId: string,
  organizationId: string
): Promise<{ id: string; role: string } | undefined> => {
  return database
    .select({ id: schema.member.id, role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, callerId),
        eq(schema.member.organizationId, organizationId)
      )
    )
    .get();
};

const checkCallerDeletePermissions = (
  context: any,
  callerMembership: { id: string; role: string } | undefined
): Response | null => {
  if (!callerMembership) {
    return context.json(
      { error: 'Forbidden', message: 'Access denied to this organization' },
      403
    );
  }

  if (callerMembership.role !== 'owner' && callerMembership.role !== 'admin') {
    return context.json(
      { error: 'Forbidden', message: 'Insufficient permissions' },
      403
    );
  }

  return null;
};

teamInvitationRoutes.delete('/invitations/:invitationId', async context => {
  const invitationId = context.req.param('invitationId');
  const callerId = extractCallerId(context);

  if (!callerId) {
    return context.json(
      { error: 'Unauthorized', message: 'Authentication required' },
      401
    );
  }

  const database = drizzle(context.env.DB, { schema });
  const invitation = await findInvitationById(database, invitationId);

  if (!invitation) {
    return context.json(
      { error: 'Not Found', message: 'Invitation not found' },
      404
    );
  }

  const callerMembership = await verifyCallerAdminRole(
    database,
    callerId,
    invitation.organizationId
  );
  const permissionError = checkCallerDeletePermissions(
    context,
    callerMembership
  );
  if (permissionError) return permissionError;

  await database
    .update(schema.invitation)
    .set({ status: 'canceled' })
    .where(eq(schema.invitation.id, invitationId));

  return context.json({ success: true });
});

export default teamInvitationRoutes;
