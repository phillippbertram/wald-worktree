# Project automation

## Review configuration in the right context

```sh
wald -C "$checkout" config --json
```

Wald combines repository-owned `.wald.yml` with workspace-local `.wald/project.yml` overrides.
The JSON reports their sources, the effective behavior hash, and trust state. Read both sources
and the scripts referenced by the relevant hooks, tasks, or tool profile. Command steps can invoke
a direct `argv` array or use `shell` to run through `/bin/sh`.

Inspect from the relevant checkout because its project configuration can differ from the default
checkout's. Normal creation plans hooks against the selected ref plus the local override. Handoff
plans them against the source checkout. If creation reports an untrusted config at a Git revision,
inspect that revision's `.wald.yml` as well as the override. Trust in a different checkout can refer
to a different behavior hash.

With authority to trust the reviewed configuration, run
`wald -C "$checkout" config trust --yes` in the context that resolves that configuration. Trust
is local to the workspace and tied to the effective behavior hash. A behavior change requires a
new decision. If only an unprepared checkout is needed, `create` and `handoff` support
`--skip-hooks`. This skips all create hook steps for that invocation, including file copies and
symlinks. It still validates configuration, and opening a configured tool retains its trust check.
If the reviewed revision has no checkout yet, this also lets you create it first, then review
and trust the resulting checkout before running setup. Setup runs `post_create` only.

When asked to set up project automation, `wald config init <worktree> --yes` writes detected
defaults to the local `.wald/project.yml`. Use `--scope project` for a shared `.wald.yml`, or
`--scope workspace --from-project` to copy existing project configuration into the local
scope. This copy keeps the repository file. Review the resulting behavior before trusting it.

## Prepare, verify, and open

```sh
wald -C "$workspace" run verify "$checkout"
wald -C "$workspace" open "$checkout" --tool codex
```

Use a configured task if it performs the requested check. Wald applies the task's working
directory, environment, timeout, and failure policy. If the task is absent, use
`wald exec <worktree> -- <command> [arguments...]` with the project's documented command.
Long-running tasks such as `dev` run in the foreground, separately from one-shot verification.

Run `wald open --help` to see built-in profile names. Project profiles can override built-ins.
Check the effective configuration for the selected checkout and use an available profile when the
task calls for launching an editor or agent. A new session should receive the task context and the
worktree path.

## Recover from automation errors

- If `post_create` failed, keep the created checkout. Review what already ran, fix the cause, and
  retry with `wald -C "$workspace" setup "$checkout"` when repeating the hook is appropriate.
  The same command can run `post_create` after creation with `--skip-hooks`.
- To test a specific configured hook against an existing checkout, use
  `wald hook run <event> <worktree>`. It runs just that event's trusted steps. Manual
  `pre_create` and `post_remove` use an existing checkout, so their target state differs from
  automatic execution.
- For file steps, an already correct symlink is `UNCHANGED`. Existing target conflicts fail by
  default. Inspect the path before changing the configuration to `on_existing: skip` or
  `on_existing: replace`. Replacement belongs in the reviewed configuration.
- Use `wald doctor --json` to diagnose paths, registrations, config trust, missing file sources,
  and unavailable executables. A failing check can exit 1 with a valid report on stdout. Read any
  proposed repair before applying it.
