import type { Context, Next } from 'hono';
import type { Environment } from '../types';
import { verify } from 'hono/jwt';

const extractBearerToken = (
  authorizationHeader: string | undefined
): string | null => {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return authorizationHeader.substring(7);
};

const verifyAsSystemJwt = async (token: string, secret: string) => {
  return verify(token, secret, 'HS256');
};

const decodeJwtPayloadFromToken = (
  token: string
): Record<string, unknown> | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
};

const isTokenExpired = (payload: Record<string, unknown>): boolean => {
  return (
    !payload.sub || !payload.exp || (payload.exp as number) <= Date.now() / 1000
  );
};

const verifyTokenViaBetterAuthSession = async (
  token: string,
  environment: Environment
): Promise<{ userId: string; email: string; type: string } | null> => {
  const auth = (await import('../lib/auth')).createAuth(environment);
  const verified = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });

  if (!verified?.user) return null;

  return {
    userId: verified.user.id,
    email: verified.user.email,
    type: 'user',
  };
};

const verifyAsBetterAuthToken = async (
  token: string,
  environment: Environment
): Promise<{ userId: string; email: string; type: string }> => {
  const decodedPayload = decodeJwtPayloadFromToken(token);
  if (!decodedPayload || isTokenExpired(decodedPayload)) {
    throw new Error('Invalid token');
  }

  const sessionResult = await verifyTokenViaBetterAuthSession(
    token,
    environment
  );
  if (sessionResult) return sessionResult;

  return {
    userId: decodedPayload.sub as string,
    email: decodedPayload.email as string,
    type: 'user',
  };
};

const verifyAndSetJwtPayload = async (
  context: Context,
  token: string,
  environment: Environment
) => {
  try {
    const systemPayload = await verifyAsSystemJwt(
      token,
      environment.BETTER_AUTH_SECRET
    );
    context.set('jwtPayload', systemPayload);
    context.set('isSystem', systemPayload.type === 'system');
    return;
  } catch {}

  try {
    const userPayload = await verifyAsBetterAuthToken(token, environment);
    context.set('jwtPayload', userPayload);
    context.set('isSystem', false);
    return;
  } catch {}

  throw new Error('Invalid token');
};

export const jwtAuth = () => {
  return async (context: Context, next: Next) => {
    const authorizationHeader = context.req.header('Authorization');
    const token = extractBearerToken(authorizationHeader);

    if (!token) {
      return context.json({ error: 'Unauthorized' }, 401);
    }

    const environment = context.env as Environment;

    try {
      await verifyAndSetJwtPayload(context, token, environment);
      return next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return context.json({ error: 'Invalid token' }, 401);
    }
  };
};

const verifySystemToken = async (
  context: Context,
  token: string,
  environment: Environment
) => {
  const payload = await verify(token, environment.BETTER_AUTH_SECRET, 'HS256');

  if (payload.type !== 'system') {
    throw new Error('System token required');
  }

  context.set('jwtPayload', payload);
  context.set('isSystem', true);
};

export const systemJwtAuth = () => {
  return async (context: Context, next: Next) => {
    const authorizationHeader = context.req.header('Authorization');
    const token = extractBearerToken(authorizationHeader);

    if (!token) {
      return context.json({ error: 'Unauthorized' }, 401);
    }

    const environment = context.env as Environment;

    try {
      await verifySystemToken(context, token, environment);
      return next();
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message === 'System token required'
          ? 'System token required'
          : 'Invalid token';
      return context.json({ error: errorMessage }, 401);
    }
  };
};
