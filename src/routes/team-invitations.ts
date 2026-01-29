import type { Environment } from '../types';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

const inviteSchema = z.object({
  emails: z.array(z.string().email()),
  organizationId: z.string(),
  organizationName: z.string(),
  inviterName: z.string(),
  permissions: z.record(z.unknown()).optional(),
});

const teamInvitationRoutes = new Hono<{ Bindings: Environment }>();

teamInvitationRoutes.post(
  '/send-invites',
  zValidator('json', inviteSchema),
  async context => {
    const body = context.req.valid('json');
    const {
      emails,
      organizationId,
      organizationName,
      inviterName,
      permissions,
    } = body;

    const notificationServiceUrl = context.env.NOTIFICATION_SERVICE_URL;

    if (!notificationServiceUrl) {
      return context.json(
        { error: 'Notification service not configured' },
        500
      );
    }

    const results = [];
    const errors = [];

    for (const email of emails) {
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
                inviteLink: `${context.env.AUTH_CLIENT_URL}/accept-invite?org=${organizationId}&email=${encodeURIComponent(email)}`,
                permissions: permissions || {},
              },
            }),
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          errors.push({ email, error: errorData });
        } else {
          const result = await response.json();
          results.push({ email, messageId: result.messageId });
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error';
        errors.push({ email, error: errorMsg });
      }
    }

    return context.json({
      success: errors.length === 0,
      sent: results.length,
      failed: errors.length,
      results,
      errors,
    });
  }
);

export default teamInvitationRoutes;
