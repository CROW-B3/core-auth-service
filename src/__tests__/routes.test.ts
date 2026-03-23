import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/validate-env', () => ({
  validateEnv: vi.fn(),
  resolveEnvironmentType: vi.fn(() => 'local'),
  isProductionEnvironment: vi.fn(() => false),
  isDevelopmentEnvironment: vi.fn(() => true),
}));

vi.mock('../config/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../lib/auth', () => ({
  createAuth: vi.fn(() => ({
    handler: vi.fn(() => new Response('{}', { status: 200 })),
    api: {},
  })),
}));

vi.mock('../lib/org-sync', () => ({
  syncOrgAndMember: vi.fn(),
}));

vi.mock('../middleware/rate-limiter', () => ({
  authRateLimiter: vi.fn(() => async (_c: any, next: Function) => next()),
}));

vi.mock('../utils/auth-validation', () => ({
  transformBetterAuthResponse: vi.fn((response: Response) => response),
}));

vi.mock('../utils/error-handler', () => ({
  handleErrorResponse: vi.fn((_c: any, error: Error) =>
    new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  ),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    run: vi.fn(() => Promise.resolve()),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    })),
  })),
}));

vi.mock('../constants', () => ({
  LOCAL_ORIGINS: ['http://localhost:3000'],
  PROD_ORIGINS: ['https://crowai.dev'],
}));

const mockD1 = {
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({
      all: vi.fn(() => ({ results: [] })),
      first: vi.fn(() => null),
      run: vi.fn(() => ({ success: true })),
    })),
  })),
};

const mockEnv = {
  DB: mockD1,
  R2_BUCKET: { put: vi.fn(), get: vi.fn() },
  PRODUCT_CRAWL_QUEUE: { send: vi.fn() },
  ENVIRONMENT: 'local',
  BETTER_AUTH_URL: 'http://localhost:8001',
  BETTER_AUTH_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'test-google-id',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  PRODUCT_SERVICE_URL: 'http://localhost:8005',
  AUTH_CLIENT_URL: 'http://localhost:3001',
  NOTIFICATION_SERVICE_URL: 'http://localhost:8006',
  USER_SERVICE_URL: 'http://localhost:8002',
  ORGANIZATION_SERVICE_URL: 'http://localhost:8003',
  DASHBOARD_URL: 'http://localhost:3000',
  BILLING_SERVICE_URL: 'http://localhost:8007',
  SERVICE_API_KEY_USER: 'test-user-key',
  SERVICE_API_KEY_ORGANIZATION: 'test-org-key',
  SERVICE_API_KEY_BILLING: 'test-billing-key',
  SERVICE_API_KEY_NOTIFICATION: 'test-notification-key',
  SERVICE_API_KEY_PRODUCT: 'test-product-key',
  SERVICE_API_KEY_GATEWAY: 'test-gateway-key',
  SERVICE_API_KEY_WEB_INGEST: 'test-web-ingest-key',
  INTERNAL_GATEWAY_KEY: 'test-internal-key',
};

import app from '../index';

describe('core-auth-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 with healthy status', async () => {
      const res = await app.request('/health', {}, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
      expect(body.service).toBe('core-auth-service');
      expect(body.version).toBe('1.0.0');
      expect(body.timestamp).toBeDefined();
      expect(body.environment).toBe('local');
    });
  });

  describe('GET /health/ready', () => {
    it('should return readiness status', async () => {
      const res = await app.request('/health/ready', {}, mockEnv);
      // May return 200 or 503 depending on DB mock
      expect([200, 503]).toContain(res.status);
      const body = await res.json();
      expect(body.ready).toBeDefined();
      expect(body.checks).toBeDefined();
      expect(body.checks.database).toBeDefined();
    });
  });

  describe('GET / (status)', () => {
    it('should return 200 with status ok', async () => {
      const res = await app.request('/', {}, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('core-auth-service');
    });
  });

  describe('protected auth routes without auth', () => {
    it('POST /api/v1/auth/api-key/verify should return 401 without internal key', async () => {
      const res = await app.request(
        '/api/v1/auth/api-key/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'some-api-key' }),
        },
        mockEnv
      );
      expect(res.status).toBe(401);
    });

    it('POST /api/v1/auth/api-key/system-token should return 400 without key', async () => {
      const res = await app.request(
        '/api/v1/auth/api-key/system-token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
    });
  });

  describe('not found routes', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await app.request('/unknown/path', {}, mockEnv);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not Found');
    });
  });

  describe('sign-up validation', () => {
    it('should reject consumer email domains', async () => {
      const res = await app.request(
        '/api/v1/auth/sign-up/email',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@gmail.com',
            password: 'testpass123',
            name: 'Test User',
          }),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('DOMAIN_NOT_ALLOWED');
    });

    it('should reject empty name', async () => {
      const res = await app.request(
        '/api/v1/auth/sign-up/email',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@company.com',
            password: 'testpass123',
            name: '',
          }),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject HTML in name', async () => {
      const res = await app.request(
        '/api/v1/auth/sign-up/email',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@company.com',
            password: 'testpass123',
            name: '<script>alert("xss")</script>',
          }),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
