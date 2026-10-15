export interface Env {
  DB: D1Database;
  HOUSEHOLD: DurableObjectNamespace;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  SETUP_CODE: string;
}
