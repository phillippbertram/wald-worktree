import { describe, expect, it } from "vitest";
import { isImportableEnvironmentPath } from "../src/services/environment-service.js";

describe("environment import filtering", () => {
  it.each([".env", ".env.local", "apps/api/.env", "apps/web/.env.production"])(
    "accepts project environment file %s",
    (file) => {
      expect(isImportableEnvironmentPath(file)).toBe(true);
    },
  );

  it.each([
    ".env.example",
    "apps/api/.env.production.sample",
    "packages/db/.env.template",
    "node_modules/pkg/.env",
    ".pnpm/pkg/.env",
    "dist/.env",
    "fixtures/.env",
    "apps/api/config.env",
  ])("rejects generated or non-secret file %s", (file) => {
    expect(isImportableEnvironmentPath(file)).toBe(false);
  });
});
