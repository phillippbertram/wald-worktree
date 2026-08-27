# Project automation

Ygg merges optional repository-owned `.ygg.yml` behavior with workspace-local
`.ygg/project.yml` overrides. Validate both reported sources and the effective behavior before
granting trust:

```sh
ygg config
ygg config trust --yes
```

Create the recommended local starting configuration with `ygg config init`. In non-interactive
sessions, use `ygg config init <worktree> --yes`; replacing an existing local file also requires
`--force`. Use `--scope project` only when `.ygg.yml` should be committed and shared. To migrate an
existing repository file locally without deleting it, use
`ygg config init <worktree> --scope workspace --from-project --yes`.

Run named tasks in the selected worktree:

```sh
ygg run <task> <worktree>
```

An automatically detected package script named exactly `dev` is exposed separately as
`ygg run dev`; it is not part of the one-shot `verify` task. Interrupting a foreground task with
`Ctrl-C` exits with status 130.

Prefer tasks over reimplementing their commands because tasks preserve configured order,
environment variables, timeouts, working directories, and failure handling.

Run any configured lifecycle hook manually after changing project configuration:

```sh
ygg hook run <pre_create|post_create|pre_remove|post_remove> <worktree>
```

The command reloads the effective repository base and workspace-local overrides, requires semantic
trust, and runs only the selected steps. It never creates or removes a worktree. Manual
`pre_create` and `post_remove` use an existing target and therefore do not reproduce their automatic
lifecycle state; Ygg prints a warning. `ygg setup <worktree>` remains the recovery shortcut for
`post_create`.

Command steps using `argv` do not invoke a shell. A configured `shell` step explicitly uses
`/bin/sh -c`; review quoting and expansion accordingly. `copy` and `symlink` steps are restricted to
the target worktree and supported source roots. For multiple files, use one positive glob below an
explicit source directory while preserving repository-relative paths:

```yaml
- type: symlink
  source: shared
  from: env
  glob: "**/.env*"
  to: .
```

Glob steps process files only, validate every destination before changing targets, and require
`optional: true` when no match should be accepted. Copy and symlink steps print scoped source and
target paths for every processed file. Commands print their exact configured invocation and resolved
working directory before execution, followed by the outcome; environment values are never printed.
Each hook or named task has its own labeled output block. Consecutive hooks and the individual step
groups inside a block are separated by blank lines; every step prints `RUNNING` before execution.

An already correct symlink is `UNCHANGED`. Other existing targets fail safely by default. Configure
`on_existing: skip` to preserve them with a `SKIPPED` status or `on_existing: replace` to remove and
recreate them. Do not look for a runtime `--force`: replacement is intentionally part of the trusted
configuration. Legacy `overwrite: true` remains compatible with `on_existing: replace`. Optional
missing sources and empty globs print a skip reason; non-optional cases remain errors.
