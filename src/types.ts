export interface CrawlJobMessage {
  jobId: string;
  organizationId: string;
  url: string;
}

export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  PRODUCT_CRAWL_QUEUE: Queue<CrawlJobMessage>;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PRODUCT_SERVICE_URL: string;
}
