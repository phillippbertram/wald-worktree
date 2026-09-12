import { describe, expect, it } from "vitest";
import { ShellService } from "../src/services/shell-service.js";

describe("shell integration", () => {
  const shells = new ShellService();

  it.each(["bash", "zsh", "fish"] as const)(
    "renders navigation through the path-only protocol for %s",
    (shell) => {
      const script = shells.render(shell);

      expect(script).toContain("--cd");
      expect(script).toContain("--print-path");
      expect(script).toContain("handoff");
      expect(script).toContain("plant");
      expect(script).toContain("builtin cd");
      expect(script).toContain("command wald");
      expect(script).not.toContain("wald completion");
      expect(script).not.toContain("_wald_complete");
    },
  );
});
