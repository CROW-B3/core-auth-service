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
  AUTH_CLIENT_URL: string;
  NOTIFICATION_SERVICE_URL: string;
  USER_SERVICE_URL: string;
  DASHBOARD_URL: string;
  BILLING_SERVICE_URL: string;
  SERVICE_API_KEY_USER: string;
  SERVICE_API_KEY_ORGANIZATION: string;
  SERVICE_API_KEY_BILLING: string;
  SERVICE_API_KEY_NOTIFICATION: string;
  SERVICE_API_KEY_PRODUCT: string;
}
