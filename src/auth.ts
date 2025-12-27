import { betterAuth } from 'better-auth';

export const auth = betterAuth({
  database: null,
  trustedOrigins: [],
  emailAndPassword: { enabled: true },
});
