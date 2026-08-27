import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import { ProjectConfigInitializer } from "../src/services/project-config-initializer.js";

describe("project configuration initialization", () => {
  let root: string;
  const initializer = new ProjectConfigInitializer();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-config-init-test-"));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await fs.writeFile(path.join(root, ".env.example"), "API_URL=\n", "utf8");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { build: "tsc", dev: "vite", lint: "biome check .", test: "vitest" },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("detects project conventions and builds explicit hooks and tasks", async () => {
    const inspection = await initializer.inspect(root);
    expect(inspection).toMatchObject({
      packageManager: "pnpm",
      installCommand: ["pnpm", "install", "--frozen-lockfile"],
      recommendedScripts: ["lint", "test"],
      developmentScript: "dev",
      environmentExample: ".env.example",
    });

    const config = initializer.createConfig(inspection, {
      fetch: true,
      install: true,
      copyEnvironment: true,
      scripts: [...inspection.recommendedScripts, "dev"],
      development: true,
      tool: "codex",
    });

    expect(config.defaults).toEqual({ fetch: true, tool: "codex" });
    expect(config.hooks.post_create).toEqual([
      expect.objectContaining({
        type: "command",
        argv: ["pnpm", "install", "--frozen-lockfile"],
      }),
      expect.objectContaining({
        type: "copy",
        from: ".env.example",
        to: ".env",
      }),
    ]);
    expect(config.tasks.verify?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "lint"] }),
      expect.objectContaining({ argv: ["pnpm", "run", "test"] }),
    ]);
    expect(config.tasks.dev?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "dev"] }),
    ]);
    const overlay = initializer.createWorkspaceOverlay(inspection, {
      fetch: true,
      install: true,
      copyEnvironment: false,
      scripts: [],
      development: false,
    });
    expect(overlay).toEqual({
      version: 1,
      defaults: { fetch: true },
      hooks: {
        post_create: [expect.objectContaining({ argv: ["pnpm", "install", "--frozen-lockfile"] })],
      },
    });

    const configs = new ConfigService();
    const document = await configs.writeProjectConfig(root, config);
    expect(document.path).toBe(path.join(root, ".ygg.yml"));
    expect(await fs.readFile(document.path, "utf8")).toContain("post_create:");
    await expect(configs.writeProjectConfig(root, config)).rejects.toThrow(/already exists/u);
    await expect(
      configs.writeProjectConfig(
        root,
        { ...config, defaults: { fetch: false } },
        { overwrite: true },
      ),
    ).resolves.toMatchObject({ config: { defaults: { fetch: false } } });
  });
});
