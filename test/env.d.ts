import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      HOUSEHOLD: DurableObjectNamespace;
      MEDIA: R2Bucket;
      ASSETS: Fetcher;
      SETUP_CODE: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
