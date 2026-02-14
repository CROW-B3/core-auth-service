import { rateLimiter } from 'hono-rate-limiter';

const TEN_MINUTES_IN_MILLISECONDS = 10 * 60 * 1000;
const ONE_MINUTE_IN_MILLISECONDS = 1 * 60 * 1000;
const MAX_AUTH_REQUESTS_PER_WINDOW = 10;
const MAX_GENERAL_REQUESTS_PER_WINDOW = 100;

const extractClientIpAddress = (c: any): string =>
  c.req.header('x-forwarded-for') ||
  c.req.header('cf-connecting-ip') ||
  'unknown';

export const authRateLimiter = () =>
  rateLimiter({
    windowMs: TEN_MINUTES_IN_MILLISECONDS,
    limit: MAX_AUTH_REQUESTS_PER_WINDOW,
    standardHeaders: 'draft-6',
    keyGenerator: extractClientIpAddress,
    handler: c => {
      return c.json(
        {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message:
              'Too many authentication attempts. Please try again later.',
            timestamp: new Date().toISOString(),
          },
        },
        429
      );
    },
  });

export const generalRateLimiter = () =>
  rateLimiter({
    windowMs: ONE_MINUTE_IN_MILLISECONDS,
    limit: MAX_GENERAL_REQUESTS_PER_WINDOW,
    standardHeaders: 'draft-6',
    keyGenerator: extractClientIpAddress,
    handler: c => {
      return c.json(
        {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
            timestamp: new Date().toISOString(),
          },
        },
        429
      );
    },
  });
