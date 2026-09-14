# Roadmap

Wald's v1 covers the day-to-day worktree lifecycle. It can create, prepare, inspect, rename, hand
off, and safely remove worktrees from the interactive CLI or direct commands. Trusted YAML
automation, shell integration, JSON output, diagnostics, and the portable Agent Skill work on macOS
and Linux.

Next on the roadmap: teach the setup wizard about more kinds of projects. Larger coordination
features can wait until everyday use shows which ones are actually needed.

## Next

### Additional project detectors

- Add Flutter, iOS, Rust, or other setup detection once concrete repositories establish safe
  defaults.
- Projects that Wald does not detect can still use commands written by hand in `.wald/project.yml`
  or `.wald.yml`.

## Later, if real projects need it

- Create several worktrees in one operation after the single-create lifecycle has proven itself in
  daily use.
- Give each worktree a stable local runtime identity: a workspace-owned ID or slot maps to a fixed
  port offset and Compose project name. Expose these values only to trusted hooks, tasks, and tools;
  never rewrite or synthesize project `.env` files automatically.
- Protect lifecycle changes with a workspace lease and recovery journal. Read-only commands remain
  safe to run in parallel; a later doctor check can identify abandoned operations before recovery.
- Run one command across explicitly selected worktrees and report a result for each one.
- Show optional GitHub or GitLab pull-request metadata.
- Prepare the package for distribution with publishable boundaries, a changelog, provenance,
  release automation, and global-install verification. That work follows broader real-world use.
- Treat Windows as a separate platform effort, backed by dedicated tests for paths, processes, and
  symlinks.
- Consider running agent-session transfer, reusable patch apply/unapply, and sandbox orchestration
  only after their permission and recovery models are clear. The existing `handoff` command
  transfers code state only.

## Principles

- Git remains the source of truth.
- Interactive operations have deterministic direct-command equivalents.
- Executable project behavior requires semantic trust.
- Destructive operations are previewed or confirmed and preserve branches by default.
- New abstractions must solve observed workflow friction.
