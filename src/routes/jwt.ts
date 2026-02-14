import type { Environment } from '../types';
import { Hono } from 'hono';
import { generateSystemJWT, verifySystemJWT } from '../lib/system-jwt';

const app = new Hono<{ Bindings: Environment }>();

app.post('/verify', async c => {
  try {
    const { token } = await c.req.json<{ token: string }>();

    if (!token) {
      return c.json({ error: 'Token required' }, 400);
    }

    const systemPayload = await verifySystemJWT(c.env, token);
    if (systemPayload) {
      return c.json({ valid: true, payload: systemPayload, type: 'system' });
    }

    const auth = (await import('../lib/auth')).createAuth(c.env);
    const verifyResult = await auth.api.verifyJwt({ token });

    if (!verifyResult) {
      return c.json({ valid: false, error: 'Invalid token' }, 401);
    }

    return c.json({
      valid: true,
      payload: verifyResult,
      type: 'user',
    });
  } catch (error) {
    console.error('JWT verification error:', error);
    return c.json({ error: 'Verification failed' }, 500);
  }
});

app.post('/system/generate', async c => {
  try {
    const { service, secret } = await c.req.json<{
      service: string;
      secret: string;
    }>();

    if (!service || !secret) {
      return c.json({ error: 'Service name and secret required' }, 400);
    }

    if (secret !== c.env.BETTER_AUTH_SECRET) {
      return c.json({ error: 'Invalid secret' }, 403);
    }

    const token = await generateSystemJWT(c.env.BETTER_AUTH_SECRET, service);

    return c.json({
      token,
      expiresIn: 86400,
      type: 'system',
      service,
    });
  } catch (error) {
    console.error('System JWT generation error:', error);
    return c.json({ error: 'Generation failed' }, 500);
  }
});

app.post('/system/verify', async c => {
  try {
    const { token } = await c.req.json<{ token: string }>();

    if (!token) {
      return c.json({ error: 'Token required' }, 400);
    }

    const payload = await verifySystemJWT(c.env, token);

    if (!payload) {
      return c.json({ valid: false, error: 'Invalid system token' }, 401);
    }

    return c.json({ valid: true, payload });
  } catch (error) {
    console.error('System JWT verification error:', error);
    return c.json({ error: 'Verification failed' }, 500);
  }
});

export default app;
