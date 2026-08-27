import { describe, expect, it } from "vitest";
import {
  formatCommandForDisplay,
  formatShellForDisplay,
  redactSensitiveText,
  sanitizeTerminalText,
} from "../src/infrastructure/safe-text.js";

describe("safe terminal text", () => {
  it("escapes terminal controls while optionally preserving line breaks", () => {
    expect(sanitizeTerminalText("safe\u001b[31m\nnext")).toBe("safe\\x1b[31m\\x0anext");
    expect(sanitizeTerminalText("safe\u001b[31m\nnext", { multiline: true })).toBe(
      "safe\\x1b[31m\nnext",
    );
  });

  it("redacts sensitive argv flags, assignments, and URL credentials", () => {
    const formatted = formatCommandForDisplay([
      "deploy",
      "--token",
      "visible-secret",
      "API_KEY=another-secret",
      "https://user:password@example.test/path?password=query-secret",
      "normal-value",
    ]);

    expect(formatted).not.toContain("visible-secret");
    expect(formatted).not.toContain("another-secret");
    expect(formatted).not.toContain("query-secret");
    expect(formatted).toContain("--token <redacted>");
    expect(formatted).toContain("normal-value");
  });

  it("redacts sensitive shell fragments and diagnostic URLs", () => {
    expect(formatShellForDisplay("TOKEN=secret deploy --password other")).toBe(
      "TOKEN=<redacted> deploy --password=<redacted>",
    );
    expect(redactSensitiveText("failed at https://user:secret@example.test/?token=value")).toBe(
      "failed at https://<redacted>@example.test/?token=<redacted>",
    );
  });
});
