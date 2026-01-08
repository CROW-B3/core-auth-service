import { z } from '@hono/zod-openapi';

export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
}

export const HelloWorldSchema = z
  .object({
    text: z.string(),
  })
  .openapi('HelloWorld');

export const StatusSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi('Status');
