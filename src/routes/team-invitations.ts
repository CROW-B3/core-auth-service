import type { Environment } from '../types';
import { Hono } from 'hono';
import { z } from 'zod';

const INVITATION_SCHEMA = z.object({
  emails: z.array(z.string().email()),
  organizationId: z.string(),
  organizationName: z.string(),
  inviterName: z.string(),
  permissions: z.any().optional(),
});

type InvitationRequest = z.infer<typeof INVITATION_SCHEMA>;

interface InvitationResult {
  email: string;
  messageId?: string;
  error?: string;
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

const sendInvitationEmail = async (
  notificationServiceUrl: string,
  email: string,
  organizationName: string,
  inviterName: string,
  inviteLink: string
): Promise<InvitationResult> => {
  try {
    const response = await fetch(
      `${notificationServiceUrl}/api/v1/notifications/email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email,
          template: 'organization-invite',
          data: {
            organizationName,
            inviterName,
            inviteLink,
            role: 'member',
          },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      return { email, error: errorData };
    }

    const result = await response.json();
    return { email, messageId: result.messageId };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    return { email, error: errorMessage };
  }
};

const sendInvitationsToAllEmails = async (
  notificationServiceUrl: string,
  authClientUrl: string,
  invitationData: InvitationRequest
): Promise<{ results: InvitationResult[]; errors: InvitationResult[] }> => {
  const results: InvitationResult[] = [];
  const errors: InvitationResult[] = [];

  for (const email of invitationData.emails) {
    const inviteLink = buildInviteLink(
      authClientUrl,
      invitationData.organizationId,
      invitationData.organizationName,
      email
    );

    const result = await sendInvitationEmail(
      notificationServiceUrl,
      email,
      invitationData.organizationName,
      invitationData.inviterName,
      inviteLink
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
    console.error(
      '[TEAM-INVITATIONS] Error details:',
      error instanceof Error ? error.message : 'Unknown error'
    );

    return context.json(
      {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      400
    );
  }

  const notificationServiceUrl = context.env.NOTIFICATION_SERVICE_URL;
  if (!notificationServiceUrl) {
    return context.json({ error: 'Notification service not configured' }, 500);
  }

  const { results, errors } = await sendInvitationsToAllEmails(
    notificationServiceUrl,
    context.env.AUTH_CLIENT_URL,
    invitationData
  );

  return context.json({
    success: errors.length === 0,
    sent: results.length,
    failed: errors.length,
    results,
    errors,
  });
});

export default teamInvitationRoutes;
