export interface Env {
  DB: D1Database;
  HOUSEHOLD: DurableObjectNamespace;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  SETUP_CODE: string;
  /** Optional seat cap override, for local testing only (.dev.vars). Production leaves it unset. */
  MAX_MEMBERS?: string;
}
