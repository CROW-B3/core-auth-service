import type { Environment } from '../types';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, apiKey, jwt, organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

const getAuthClientBaseUrl = (env: Environment): string => {
  if (env.ENVIRONMENT === 'local') return 'http://localhost:3000';
  if (env.ENVIRONMENT === 'dev') return 'https://dev.auth.crowai.dev';
  return 'https://auth.crowai.dev';
};

const getNotificationServiceUrl = (env: Environment): string => {
  if (env.ENVIRONMENT === 'local') return 'http://localhost:8006';
  if (env.ENVIRONMENT === 'dev')
    return 'https://dev.internal.notifications.crowai.dev';
  return 'https://internal.notifications.crowai.dev';
};

export const createAuth = (env: Environment) => {
  const db = drizzle(env.DB, { schema });
  const authClientBaseUrl = getAuthClientBaseUrl(env);
  const notificationServiceUrl = getNotificationServiceUrl(env);

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/v1/auth',
    secret: env.BETTER_AUTH_SECRET,

    emailAndPassword: {
      enabled: true,
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
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        sendInvitationEmail: async data => {
          const inviteLink = `${authClientBaseUrl}/accept-invite/${data.id}`;
          await fetch(`${notificationServiceUrl}/api/v1/notifications/email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: data.email,
              template: 'organization-invite',
              data: {
                inviteLink,
                organizationName: data.organization.name,
                inviterName: data.inviter.name,
                role: data.role,
              },
            }),
          });
        },
      }),
      apiKey({
        defaultPrefix: 'crow_',
        defaultKeyLength: 32,
        rateLimit: {
          enabled: true,
          window: 60 * 60,
          max: 1000,
        },
        enableMetadata: true,
      }),
    ],
  });
};
