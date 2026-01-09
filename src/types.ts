export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
}
