import type { Environment } from '../types';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous } from 'better-auth/plugins/anonymous';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/d1';

export const createAuth = (env: Environment) => {
  const db = drizzle(env.DB);

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    trustedOrigins: [
      'https://crowai.dev',
      'https://app.crowai.dev',
      'https://api.crowai.dev',
      'https://internal.auth-api.crowai.dev',
      'https://dev.crowai.dev',
      'https://dev.app.crowai.dev',
      'https://dev.api.crowai.dev',
      'https://dev.internal.auth-api.crowai.dev',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:8000',
      'http://localhost:8001',
    ],

    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: '.crowai.dev',
      },
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
