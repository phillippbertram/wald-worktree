import { describe, expect, it } from "vitest";
import { WtError } from "../src/domain/errors.js";
import {
  parseWorktreePorcelain,
  slugifyBranch,
  validateWorktreeName,
} from "../src/services/worktree-service.js";

describe("worktree domain", () => {
  it("derives safe and stable directory names from branches", () => {
    expect(slugifyBranch("feature/payment flow")).toBe("feature-payment-flow");
    expect(slugifyBranch("release/1.2.0")).toBe("release-1.2.0");
  });

  it.each(["", ".", "..", ".wt", "repo.git", "nested/name", "nested\\name", " line"])(
    "rejects reserved or nested worktree name %s",
    (name) => {
      expect(() => validateWorktreeName(name)).toThrow(WtError);
    },
  );

  it("parses Git's stable NUL-delimited porcelain format", () => {
    const output = [
      "worktree /tmp/repo.git\0bare\0\0",
      "worktree /tmp/main\0HEAD abc123\0branch refs/heads/main\0\0",
      "worktree /tmp/feature\0HEAD def456\0branch refs/heads/feature/test\0locked maintenance\0\0",
    ].join("");

    expect(parseWorktreePorcelain(output)).toEqual([
      expect.objectContaining({ path: "/tmp/repo.git", bare: true }),
      expect.objectContaining({ path: "/tmp/main", branch: "main", locked: false }),
      expect.objectContaining({
        path: "/tmp/feature",
        branch: "feature/test",
        locked: true,
        lockReason: "maintenance",
      }),
    ]);
  });
});
