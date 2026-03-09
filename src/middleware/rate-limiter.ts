import type { MiddlewareHandler } from 'hono';

const TEN_MINUTES_IN_MS = 10 * 60 * 1000;
const MAX_AUTH_REQUESTS = 300;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Store is created lazily inside the handler to avoid global-scope I/O
// (Cloudflare Workers error 10021).
let authStore: Map<string, RateLimitEntry> | null = null;

const getStore = (): Map<string, RateLimitEntry> => {
  if (!authStore) {
    authStore = new Map();
  }
  return authStore;
};

const getClientKey = (c: Parameters<MiddlewareHandler>[0]): string =>
  c.req.header('cf-connecting-ip') ||
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
  'unknown';

export const authRateLimiter = (): MiddlewareHandler => async (c, next) => {
  const store = getStore();
  const key = getClientKey(c);
  const now = Date.now();

  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + TEN_MINUTES_IN_MS });
    return next();
  }

  if (entry.count >= MAX_AUTH_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    c.header('Retry-After', String(retryAfter));
    c.header('X-RateLimit-Limit', String(MAX_AUTH_REQUESTS));
    c.header('X-RateLimit-Remaining', '0');
    return c.json(
      {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many authentication attempts. Please try again later.',
          timestamp: new Date().toISOString(),
        },
      },
      429
    );
  }

  entry.count += 1;
  await next();
};
