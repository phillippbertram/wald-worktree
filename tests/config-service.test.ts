import { describe, expect, it } from "vitest";
import {
  ConfigService,
  projectConfigFileName,
  summarizeExecutableConfig,
  workspaceConfigFileName,
} from "../src/services/config-service.js";

describe("project YAML configuration", () => {
  const configs = new ConfigService();

  it("uses the clean-break .yml filenames", () => {
    expect(projectConfigFileName).toBe(".ygg.yml");
    expect(workspaceConfigFileName).toBe("workspace.yml");
  });

  it("uses a semantic hash so comments and key order do not invalidate trust", () => {
    const first = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install]
tasks:
  check:
    steps:
      - type: command
        argv: [pnpm, test]
`,
      ".ygg.yml",
    );
    const reformatted = configs.parseProjectConfig(
      `# formatting is not behavior
tasks:
  check:
    steps:
      - argv:
          - pnpm
          - test
        type: command
hooks:
  post_create:
    - argv: [pnpm, install]
      type: command
version: 1
`,
      ".ygg.yml",
    );
    const changed = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install, --frozen-lockfile]
tasks:
  check:
    steps:
      - type: command
        argv: [pnpm, test]
`,
      ".ygg.yml",
    );

    expect(first.requiresTrust).toBe(true);
    expect(reformatted.hash).toBe(first.hash);
    expect(changed.hash).not.toBe(first.hash);
  });

  it("rejects unknown fields and ambiguous command execution", () => {
    expect(() =>
      configs.parseProjectConfig(
        `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install]
      shell: pnpm install
      surprise: true
`,
        ".ygg.yml",
      ),
    ).toThrow(/Configuration is invalid/u);
  });

  it("does not require trust for declarative defaults alone", () => {
    const document = configs.parseProjectConfig(
      `version: 1
defaults:
  fetch: false
`,
      ".ygg.yml",
    );

    expect(document.requiresTrust).toBe(false);
    expect(document.config.defaults).toEqual({ fetch: false });
  });

  it("allows empty command arguments but requires a non-empty executable", () => {
    const document = configs.parseProjectConfig(
      `version: 1
tasks:
  empty-argument:
    steps:
      - type: command
        argv: [printf, ""]
`,
      ".ygg.yml",
    );

    expect(document.config.tasks["empty-argument"]?.steps[0]).toMatchObject({
      argv: ["printf", ""],
    });
    expect(() =>
      configs.parseProjectConfig(
        `version: 1
tools:
  broken:
    command: [""]
`,
        ".ygg.yml",
      ),
    ).toThrow(/first argv entry must name an executable/u);
  });

  it("accepts shared as a declarative file source", () => {
    const document = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
`,
      ".ygg.yml",
    );

    expect(document.config.hooks.post_create[0]).toMatchObject({
      type: "symlink",
      source: "shared",
      from: "env/.env",
      to: ".env",
    });
    expect(document.requiresTrust).toBe(true);
    expect(summarizeExecutableConfig(document)).toContain(
      "hook post_create: symlink shared:env/.env -> .env",
    );
  });

  it("parses glob file steps and includes the pattern in trust behavior", () => {
    const first = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .
`,
      ".ygg.yml",
    );
    const changed = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/*.json"
      to: .
`,
      ".ygg.yml",
    );

    expect(first.config.hooks.post_create[0]).toMatchObject({
      type: "symlink",
      from: "env",
      glob: "**/.env*",
      to: ".",
    });
    expect(first.hash).not.toBe(changed.hash);
    expect(configs.formatProjectConfig(first.config)).toContain('glob: "**/.env*"');
    expect(summarizeExecutableConfig(first)).toContain(
      "hook post_create: symlink shared:env/**/.env* -> .",
    );
  });

  it.each(["../*.env", "/tmp/*.env", "!secret.env", "C:\\\\secrets\\\\*.env"])(
    "rejects unsafe glob pattern %s",
    (glob) => {
      expect(() =>
        configs.parseProjectConfig(
          `version: 1
hooks:
  post_create:
    - type: copy
      from: env
      glob: ${JSON.stringify(glob)}
      to: .
`,
          ".ygg.yml",
        ),
      ).toThrow(/positive relative pattern/u);
    },
  );
});
