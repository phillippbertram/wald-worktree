import { describe, expect, it } from "vitest";
import { ConfigService } from "../src/services/config-service.js";

describe("project YAML configuration", () => {
  const configs = new ConfigService();

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
      ".wt.yaml",
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
      ".wt.yaml",
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
      ".wt.yaml",
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
        ".wt.yaml",
      ),
    ).toThrow(/Configuration is invalid/u);
  });

  it("does not require trust for declarative defaults alone", () => {
    const document = configs.parseProjectConfig(
      `version: 1
defaults:
  fetch: false
`,
      ".wt.yaml",
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
      ".wt.yaml",
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
        ".wt.yaml",
      ),
    ).toThrow(/first argv entry must name an executable/u);
  });
});
