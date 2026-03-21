import type { Environment } from '../types';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, apiKey, jwt, organization } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sendOrganizationInviteEmail } from '../clients/notification';
import * as schema from '../db/schema';

export const createAuth = (env: Environment) => {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/v1/auth',
    secret: env.BETTER_AUTH_SECRET,

    rateLimit:
      env.ENVIRONMENT === 'prod'
        ? {
            enabled: true,
            window: 60,
            max: 100,
          }
        : {
            enabled: false,
          },

    onAPIError: { throw: true },

    session: {
      updateAge: 24 * 60 * 60,
      expiresIn: 7 * 24 * 60 * 60,
      cookieCache: {
        enabled: false,
      },
    },

    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        await fetch(
          `${env.NOTIFICATION_SERVICE_URL}/api/v1/notifications/email`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(env.INTERNAL_GATEWAY_KEY && {
                'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
              }),
            },
            body: JSON.stringify({
              to: user.email,
              subject: 'Reset your CROW password',
              html: `<p>Hi ${user.name || 'there'},</p><p>We received a request to reset your password. Click the link below to set a new password:</p><p><a href="${url}" style="display:inline-block;padding:12px 24px;background-color:#7c3aed;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Reset Password</a></p><p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p><p>— The CROW Team</p>`,
            }),
          }
        );
      },
      ...(env.ENVIRONMENT === 'prod'
        ? {
            rateLimit: {
              enabled: true,
              timeWindow: 60,
              maxRequests: 5,
            },
          }
        : {}),
    },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    trustedOrigins: [
      'https://crowai.dev',
      'https://auth.crowai.dev',
      'https://app.crowai.dev',
      'https://dashboard.crowai.dev',
      'https://api.crowai.dev',
      'https://internal.auth-api.crowai.dev',
      'https://dev.crowai.dev',
      'https://dev.auth.crowai.dev',
      'https://dev.app.crowai.dev',
      'https://dev.dashboard.crowai.dev',
      'https://dev.api.crowai.dev',
      'https://dev.internal.auth-api.crowai.dev',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:8000',
      'http://localhost:8001',
    ],

    advanced: {
      crossSubDomainCookies:
        env.ENVIRONMENT === 'local'
          ? { enabled: false }
          : { enabled: true, domain: '.crowai.dev' },
    },

    plugins: [
      anonymous({
        emailDomainName: 'anon.crowai.dev',
        onLinkAccount: async _ => {},
      }),
      jwt({
        jwks: {
          keyPairConfig: { alg: 'RS256' },
        },
        jwt: {
          definePayload: async ({ user, session }) => {
            let organizationId: string | undefined;
            try {
              const res = await fetch(
                `${env.USER_SERVICE_URL}/api/v1/users/by-auth-id/${user.id}`,
                {
                  headers: {
                    ...(env.INTERNAL_GATEWAY_KEY && {
                      'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
                    }),
                    ...(env.SERVICE_API_KEY_USER && {
                      'X-Service-API-Key': env.SERVICE_API_KEY_USER,
                    }),
                  },
                }
              );
              if (res.ok) {
                const data = (await res.json()) as { organizationId?: string };
                organizationId = data.organizationId;
              }
            } catch {}
            return {
              ...user,
              organizationId,
              activeOrganizationId: (session as Record<string, unknown>)
                .activeOrganizationId,
            };
          },
        },
      }),
      organization({
        allowUserToCreateOrganization: true,
        sendInvitationEmail: async data => {
          await sendOrganizationInviteEmail(
            env.NOTIFICATION_SERVICE_URL,
            {
              to: data.email,
              inviteLink: `${env.AUTH_CLIENT_URL}/accept-invite/${data.id}`,
              organizationName: data.organization.name,
              inviterName: (data.inviter as any).name,
              role: data.role,
            },
            env.INTERNAL_GATEWAY_KEY
          );
        },
      }),
      apiKey({
        defaultPrefix: 'crow_',
        defaultKeyLength: 32,
        rateLimit: {
          enabled: true,
          timeWindow: 60 * 60,
          maxRequests: 1000,
        },
        enableMetadata: true,
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          after: async (user: any) => {
            // Skip anonymous users
            if (user.isAnonymous) return;
            try {
              const now = new Date();
              const pendingInvitations = await db
                .select()
                .from(schema.invitation)
                .where(
                  and(
                    eq(schema.invitation.email, user.email),
                    eq(schema.invitation.status, 'pending')
                  )
                );

              for (const invite of pendingInvitations) {
                // Skip expired invitations
                if (invite.expiresAt < now) continue;

                // Check not already a member
                const existing = await db
                  .select({ id: schema.member.id })
                  .from(schema.member)
                  .where(
                    and(
                      eq(schema.member.userId, user.id),
                      eq(schema.member.organizationId, invite.organizationId)
                    )
                  )
                  .limit(1);

                if (existing.length > 0) continue;

                // Add as member — triggers member.create.after to sync to user service
                await db.insert(schema.member).values({
                  id: crypto.randomUUID(),
                  organizationId: invite.organizationId,
                  userId: user.id,
                  role: invite.role as 'member' | 'admin',
                  createdAt: now,
                });

                // Mark invitation accepted
                await db
                  .update(schema.invitation)
                  .set({ status: 'accepted' })
                  .where(eq(schema.invitation.id, invite.id));

                console.warn(
                  '[databaseHooks] user.create: auto-accepted pending invitation',
                  {
                    userId: user.id,
                    email: user.email,
                    organizationId: invite.organizationId,
                  }
                );
              }
            } catch (err) {
              console.error(
                '[databaseHooks] user.create: error checking pending invitations',
                err
              );
            }
          },
        },
      },
      organization: {
        create: {
          after: async (organization: any) => {
            try {
              const systemHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                ...(env.INTERNAL_GATEWAY_KEY && {
                  'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
                }),
                ...(env.SERVICE_API_KEY_ORGANIZATION && {
                  'X-Service-API-Key': env.SERVICE_API_KEY_ORGANIZATION,
                }),
              };
              const existingRes = await fetch(
                `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations/by-auth-id/${organization.id}`,
                { headers: systemHeaders }
              );
              if (existingRes.ok) return;
              const createRes = await fetch(
                `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations`,
                {
                  method: 'POST',
                  headers: systemHeaders,
                  body: JSON.stringify({
                    betterAuthOrgId: organization.id,
                    name: organization.name,
                  }),
                }
              );
              if (!createRes.ok) {
                const errBody = await createRes.text();
                console.error(
                  '[databaseHooks] organization.create: failed to sync org to org service',
                  { status: createRes.status, body: errBody }
                );
              }
            } catch (err) {
              console.error(
                '[databaseHooks] organization.create: unexpected error during sync',
                err
              );
            }
          },
        },
      },
      member: {
        create: {
          after: async (member: any) => {
            try {
              const userResults = await db
                .select({ email: schema.user.email, name: schema.user.name })
                .from(schema.user)
                .where(eq(schema.user.id, member.userId))
                .limit(1);

              if (!userResults[0]) {
                console.error(
                  '[databaseHooks] member.create: user not found in auth DB',
                  {
                    userId: member.userId,
                  }
                );
                return;
              }

              const { email, name } = userResults[0];

              const orgHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                ...(env.INTERNAL_GATEWAY_KEY && {
                  'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
                }),
                ...(env.SERVICE_API_KEY_ORGANIZATION && {
                  'X-Service-API-Key': env.SERVICE_API_KEY_ORGANIZATION,
                }),
              };

              const orgRes = await fetch(
                `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations/by-auth-id/${member.organizationId}`,
                { headers: orgHeaders }
              );

              if (!orgRes.ok) {
                console.error(
                  '[databaseHooks] member.create: failed to resolve org from org service',
                  {
                    betterAuthOrgId: member.organizationId,
                    status: orgRes.status,
                  }
                );
                return;
              }

              const orgData = (await orgRes.json()) as { id: string };

              const userHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                ...(env.INTERNAL_GATEWAY_KEY && {
                  'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
                }),
                ...(env.SERVICE_API_KEY_USER && {
                  'X-Service-API-Key': env.SERVICE_API_KEY_USER,
                }),
              };

              const userRes = await fetch(
                `${env.USER_SERVICE_URL}/api/v1/users`,
                {
                  method: 'POST',
                  headers: userHeaders,
                  body: JSON.stringify({
                    betterAuthUserId: member.userId,
                    organizationId: orgData.id,
                    email,
                    name,
                    role:
                      member.role === 'owner'
                        ? 'member'
                        : (member.role as 'admin' | 'member'),
                  }),
                }
              );

              if (!userRes.ok) {
                const errBody = await userRes.text();
                console.error(
                  '[databaseHooks] member.create: failed to sync user to user service',
                  {
                    status: userRes.status,
                    body: errBody,
                    betterAuthUserId: member.userId,
                  }
                );
                return;
              }

              console.warn(
                '[databaseHooks] member.create: successfully synced invited member to user service',
                {
                  betterAuthUserId: member.userId,
                  organizationId: orgData.id,
                }
              );
            } catch (err) {
              console.error(
                '[databaseHooks] member.create: unexpected error during sync',
                err
              );
            }
          },
        },
      },
    } as any,
  });
};
