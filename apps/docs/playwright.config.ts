import { defineConfig, devices } from "@playwright/test";
import { basePath } from "./lib/site.mjs";

const url = `http://127.0.0.1:4137${basePath}/`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: url,
    trace: "retain-on-failure",
  },
  webServer: { command: "node scripts/serve-export.mjs", url },
});
