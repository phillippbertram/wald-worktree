# Roadmap

This document keeps planned capabilities visible without turning them into promises for a specific
release date. Priorities may change based on real-world usage and contributor feedback.

## Next: workspace maintenance

### `wt doctor`

Diagnose a managed workspace without changing it:

- Validate `.wt/config.json`, the bare repository, remotes, and default branch.
- Detect missing, locked, or inconsistent worktree metadata.
- Check shared environment links and required local tools.
- Print actionable repair commands without exposing secrets.

### `wt prune`

Safely clean stale Git worktree metadata:

- Show a dry-run preview by default.
- Preserve existing directories and locked worktrees.
- Require explicit confirmation before changing metadata.

### `wt open` and `wt path`

Make navigation easier without shell-specific integrations:

- Resolve worktrees by name, branch, or path.
- Print a path suitable for command substitution with `wt path`.
- Open a worktree in the configured editor with `wt open`.

## Later: workflow automation

### `wt exec`

Run commands in one or more worktrees:

- `wt exec <worktree> -- <command>` for a single worktree.
- An explicit `--all` mode with clear per-worktree output and exit results.
- No shell interpolation inside `wt`; commands are forwarded as argument arrays.

### Configurable bootstrap steps

Optionally prepare a newly created worktree:

- Install dependencies, initially with pnpm.
- Run explicitly configured setup commands.
- Support command previews, opt-out flags, timeouts, and useful failure reporting.
- Never execute repository-provided hooks implicitly.

### Worktree-specific runtime configuration

Allow parallel application stacks without manual port editing:

- Allocate stable port offsets.
- Generate a local `.env.worktree` file.
- Provide unique Compose project names.
- Keep generated values separate from shared secrets in `.wt/env`.

## Future: platform and distribution

### Windows support

Support Windows only after symlink behavior, path normalization, terminals, and process execution
have dedicated integration coverage. Copy-based environment fallbacks may be considered if symlinks
cannot be created safely.

### npm distribution

Publish `wt` only after its command and configuration contracts are stable enough:

- Remove the package's private guard.
- Add versioning, changelog, provenance, and release automation.
- Test global installation on every supported operating system.

### Optional interactive workspace dashboard

Explore a richer Ink dashboard for browsing worktrees and launching common actions. Scriptable
subcommands remain the canonical interface even if a dashboard is added.

## Guiding principles

- Git remains the source of truth for repositories, branches, and worktrees.
- Destructive operations require a preview or explicit confirmation.
- Existing files and uncommitted work are preserved by default.
- Interactive features always have a deterministic non-interactive equivalent.
- Features should solve demonstrated daily-workflow friction before adding configuration complexity.
