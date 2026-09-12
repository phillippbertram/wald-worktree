# Roadmap

The configurable v1 lifecycle, YAML model, interactive CLI, shell integration, tool profiles,
read-only status and doctor diagnostics, preview-first metadata pruning, worktree rename, verified
code carry and handoff, lifecycle JSON contracts, macOS/Linux coverage, and portable Agent Skill are
implemented. The next work can broaden project detection while real-world usage informs deeper
coordination features.

## Next

### Additional project detectors

- Add Flutter, iOS, Rust, or other setup detection only after concrete repositories establish safe
  defaults.
- Keep manually authored project commands in `.wald/project.yml` or `.wald.yml` as the universal
  fallback.

## Later, based on demonstrated need

- Bulk worktree creation after single-create lifecycle behavior is proven in daily use.
- Add a stable, local worktree runtime identity: a workspace-owned ID or slot maps to a deterministic
  port offset and Compose project name. Expose these values only to trusted hooks, tasks, and tools;
  never rewrite or synthesize project `.env` files automatically.
- Protect lifecycle mutations with a workspace lease and recovery journal. Read-only commands remain
  parallel-safe; a later doctor check can identify and explain abandoned operations before recovery.
- Explicit multi-worktree execution with per-worktree results.
- Optional GitHub/GitLab pull-request metadata.
- Distribution and release readiness: publishable package boundaries, changelog, provenance,
  release automation, and global-install verification. This follows broader real-world use rather
  than the current feature work.
- Windows support as a separate platform effort after path, process, and symlink behavior has
  dedicated Windows integration coverage.
- Running agent-session transfer, reusable patch apply/unapply, and sandbox orchestration only after
  their permissions and recovery models are designed explicitly. The implemented `handoff` command
  transfers code state only.

## Principles

- Git remains the source of truth.
- Interactive operations have deterministic direct-command equivalents.
- Executable project behavior requires semantic trust.
- Destructive operations are previewed or confirmed and preserve branches by default.
- New abstractions must solve observed workflow friction.
