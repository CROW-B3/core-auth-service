import type { Environment } from '../types';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous } from 'better-auth/plugins/anonymous';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export const createAuth = (env: Environment) => {
  const db = drizzle(env.DB, { schema });

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
    ],
  });
};
