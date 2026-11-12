---
title: "Prepare new worktrees"
description: "Configure repeatable setup, review effective behavior, and run the same checks in any worktree."
---

Canopy needs dependencies and local configuration before you can run it. A Git worktree gives
you the files. Wald can repeat the setup steps you approve.

## Save your setup

From the primary checkout, run:

```sh
wald config init
```

Review the suggested settings. For a detected Node project, Wald can propose an install hook,
a copy of an example environment file, named tasks, and a tool profile. Use **Show
configuration** to inspect the YAML and **Customize…** to choose the steps. The default
destination is the local workspace configuration.

## Review and trust the effective configuration

```sh
wald config
wald config trust
```

Trust only settings you have reviewed. Wald combines repository and workspace configuration;
the workspace settings override the corresponding project settings. The trust decision applies
to the effective behavior. Changes that affect it may require a fresh decision.

## Prepare and verify

```sh
wald create feature/search --tool code
wald run verify feature-search
```

Use `--tool code` if VS Code is installed and `verify` if you configured that task. If a
post-create step fails, Wald keeps the checkout. Fix the problem and run
`wald setup feature-search` to retry setup. To create a checkout without create hooks,
including configured copy and symlink steps, pass `--skip-hooks`.

The [configuration reference](configuration.md) covers the YAML schema, precedence, hooks,
tasks, and tool profiles.
