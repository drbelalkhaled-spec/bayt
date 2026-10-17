import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { SETUP_CODE: "test-setup", MAX_MEMBERS: "3", TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    // Some tests make dozens of requests; 5 s (the default) is too tight when the machine is busy.
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 15000 },
  };
});
