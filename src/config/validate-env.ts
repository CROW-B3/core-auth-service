import type { Environment } from '../types';

const REQUIRED_ENV_VARS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

export function validateEnv(env: Partial<Environment>): void {
  const missingVariables: string[] = [];
  const emptyVariables: string[] = [];

  for (const key of REQUIRED_ENV_VARS) {
    const value = env[key as keyof Environment];

    if (value === undefined || value === null) {
      missingVariables.push(key);
    } else if (typeof value === 'string' && value.trim() === '') {
      emptyVariables.push(key);
    }
  }

  const validationErrors: string[] = [];

  if (missingVariables.length > 0) {
    validationErrors.push(
      `Missing required environment variables: ${missingVariables.join(', ')}`
    );
  }

  if (emptyVariables.length > 0) {
    validationErrors.push(
      `Empty environment variables: ${emptyVariables.join(', ')}`
    );
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${validationErrors.join('\n')}\n\n` +
        'Please ensure all required environment variables are set in your .env file or deployment configuration.'
    );
  }
}

export function resolveEnvironmentType(
  env: Environment
): 'local' | 'dev' | 'prod' {
  return (env.ENVIRONMENT as 'local' | 'dev' | 'prod') || 'prod';
}

export function isProductionEnvironment(env: Environment): boolean {
  return resolveEnvironmentType(env) === 'prod';
}

export function isDevelopmentEnvironment(env: Environment): boolean {
  const environmentType = resolveEnvironmentType(env);
  return environmentType === 'dev' || environmentType === 'local';
}
