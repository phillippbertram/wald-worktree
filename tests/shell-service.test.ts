import { describe, expect, it } from "vitest";
import { ShellService } from "../src/services/shell-service.js";

describe("shell integration", () => {
  const shells = new ShellService();

  it.each(["bash", "zsh", "fish"] as const)(
    "routes create --cd through the path-only protocol for %s",
    (shell) => {
      const script = shells.render(shell);

      expect(script).toContain("--cd");
      expect(script).toContain("--print-path");
      expect(script).toContain("builtin cd");
    },
  );

  it.each(["bash", "zsh", "fish"] as const)("offers prune completion for %s", (shell) => {
    expect(shells.render(shell)).toContain("prune");
  });
});
