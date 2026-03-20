import type { Environment } from '../types';
import { sign, verify } from 'hono/jwt';

interface SystemJWTPayload {
  sub: string;
  type: string;
  service: string;
  exp: number;
}

export const generateSystemJWT = async (
  secret: string,
  service: string
): Promise<string> => {
  return await sign(
    {
      sub: 'system',
      type: 'system',
      service,
      exp: Math.floor(Date.now() / 1000) + 86400,
    },
    secret,
    'HS256'
  );
};

export const verifySystemJWT = async (
  env: Environment,
  token: string
): Promise<SystemJWTPayload | null> => {
  try {
    const payload = await verify(token, env.BETTER_AUTH_SECRET, 'HS256');

    if (payload.type !== 'system') {
      return null;
    }

    return payload as unknown as SystemJWTPayload;
  } catch {
    return null;
  }
};

export const createSystemHeaders = async (
  secret: string,
  service: string
): Promise<Record<string, string>> => {
  const token = await generateSystemJWT(secret, service);
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    // X-System-Token signals downstream services to validate the Authorization
    // header as an HS256 system JWT rather than an RS256 user JWT via JWKS.
    'X-System-Token': 'true',
  };
};
