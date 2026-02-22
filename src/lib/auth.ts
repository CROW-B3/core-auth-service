import type { Environment } from '../types';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, apiKey, jwt, organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sendOrganizationInviteEmail } from '../clients/notification';
import * as schema from '../db/schema';
import { generateSystemJWT } from './system-jwt';

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
        enabled: true,
        maxAge: 5 * 60,
      },
    },

    emailAndPassword: {
      enabled: true,
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
          // Embed the CROW internal organizationId in the JWT so downstream
          // services (billing, user, etc.) can authorize requests without
          // needing to call the user service on every request.
          definePayload: async ({ user, session }) => {
            let organizationId: string | undefined;
            try {
              const systemToken = await generateSystemJWT(
                env.BETTER_AUTH_SECRET,
                'auth-service'
              );
              const res = await fetch(
                `${env.USER_SERVICE_URL}/api/v1/users/by-auth-id/${user.id}`,
                {
                  headers: {
                    Authorization: `Bearer ${systemToken}`,
                    'X-System-Token': '1',
                  },
                }
              );
              if (res.ok) {
                const data = (await res.json()) as { organizationId?: string };
                organizationId = data.organizationId;
              }
            } catch {
              // Non-fatal: proceed without the claim
            }
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
          await sendOrganizationInviteEmail(env.NOTIFICATION_SERVICE_URL, {
            to: data.email,
            inviteLink: `${env.AUTH_CLIENT_URL}/accept-invite/${data.id}`,
            organizationName: data.organization.name,
            inviterName: data.inviter.name,
            role: data.role,
          });
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
      organization: {
        create: {
          after: async organization => {
            try {
              const systemToken = await generateSystemJWT(
                env.BETTER_AUTH_SECRET,
                'auth-service'
              );
              const systemHeaders = {
                'Content-Type': 'application/json',
                'X-System-Token': 'true',
                Authorization: `Bearer ${systemToken}`,
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
          after: async member => {
            try {
              // Fetch user details from better-auth's own user table in the same D1 DB
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

              // Build system auth headers for service-to-service calls
              const systemToken = await generateSystemJWT(
                env.BETTER_AUTH_SECRET,
                'auth-service'
              );
              const systemHeaders = {
                'Content-Type': 'application/json',
                'X-System-Token': 'true',
                Authorization: `Bearer ${systemToken}`,
              };

              // Resolve better-auth org ID -> internal organization service org ID
              const orgRes = await fetch(
                `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations/by-auth-id/${member.organizationId}`,
                { headers: systemHeaders }
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

              // Create the internal user record in the user service
              const userRes = await fetch(
                `${env.USER_SERVICE_URL}/api/v1/users`,
                {
                  method: 'POST',
                  headers: systemHeaders,
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
              // Non-fatal: log but do not throw so invitation acceptance is not blocked
              console.error(
                '[databaseHooks] member.create: unexpected error during sync',
                err
              );
            }
          },
        },
      },
    },
  });
};
