# Roadmap

The configurable v1 lifecycle, YAML model, interactive CLI, shell integration, tool profiles,
preview-first metadata pruning, and portable Agent Skill are implemented. The next work should
strengthen diagnostics before broadening the workflow model.

## Next

### `wt doctor`

- Validate local and project YAML, repository references, hooks, configured file steps, and tools.
- Detect stale or inconsistent Git worktree metadata.
- Print safe repair commands without exposing environment-file contents.

### Release readiness

- Add changelog, provenance, and npm publishing automation.
- Verify global installation across the supported Node and operating-system matrix.
- Add completion fixtures for bash, zsh, and fish releases.

### Additional project detectors

- Add Flutter, iOS, Rust, or other setup detection only after concrete repositories establish safe
  defaults.
- Keep manually authored `.wt.yml` commands as the universal fallback.

## Later, based on demonstrated need

- Optional removal of an already merged branch with a separate explicit confirmation.
- Bulk worktree creation after single-create lifecycle behavior is proven in daily use.
- Stable per-worktree runtime values such as port offsets and Compose project names.
- Explicit multi-worktree execution with per-worktree results.
- Optional GitHub/GitLab pull-request metadata.
- Windows support after path, process, and symlink behavior has dedicated integration coverage.
- Agent handoff, patch transfer, or sandbox orchestration after their permissions and recovery model
  are designed explicitly.

## Principles

- Git remains the source of truth.
- Interactive operations have deterministic direct-command equivalents.
- Executable project behavior requires semantic trust.
- Destructive operations are previewed or confirmed and preserve branches by default.
- New abstractions must solve observed workflow friction.
