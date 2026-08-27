# Configuration

`ygg` has one local workspace configuration, one local shared-file area, and up to two project
configuration sources. Every YAML document is strict and versioned; unknown fields are errors.

Read [Worktrees explained](worktrees.md) first if the distinction between the shared repository and
per-worktree state is unfamiliar.

## Local workspace configuration

Dedicated workspaces store `.ygg/workspace.yml`. Adopted repositories store
`<git-common-dir>/ygg/workspace.yml` and expose it through a `.ygg` link in the worktree container.
This file is local and should not be committed. The terms `managed` and `adopted` are internal
layout and safety states; the CLI describes them as a standalone workspace root or a retained
existing checkout.

```yaml
version: 1
mode: managed
paths:
  git: ../repo.git
  worktrees: ..
  primary_worktree: null
remote:
  name: origin
  fetch_refspec: +refs/heads/*:refs/remotes/origin/*
default_branch: main
trusted_project_config: null
```

All stored paths are relative to the configuration. `ygg` canonicalizes them and enforces the
layout boundaries before using them.

### Workspace field reference

| Field | Type/default | Meaning and typical use |
| --- | --- | --- |
| `version` | `1` | Workspace schema version. |
| `mode` | `managed` or `adopted` | Internal safety mode. `managed` uses `repo.git`; `adopted` protects an existing primary checkout. |
| `paths.git` | relative path | Git common directory used for all worktree operations. Generated and validated by `ygg`. |
| `paths.worktrees` | relative path | Parent directory in which `ygg` creates worktrees. |
| `paths.primary_worktree` | relative path or `null` | Original checkout protected from `ygg remove`; always `null` for a standalone bare workspace. |
| `remote` | object or `null` | Optional remote used for fetch and remote-branch resolution. `null` keeps the workspace local-only. |
| `remote.name` | string | Existing Git remote name such as `origin` or `upstream`. |
| `remote.fetch_refspec` | string | Explicit branch mapping used when `ygg create` fetches. |
| `default_branch` | branch name | Default base, merge-check target, and preferred project-configuration branch. |
| `trusted_project_config` | SHA-256 or `null` | Semantic hash of the trusted effective project behavior. |

`default_branch` does three jobs:

1. New branches start from its remote-tracking or local ref when `--from` is omitted.
2. Safe removal checks whether a branch is merged into it.
3. `ygg` uses its worktree/ref for repository project configuration and `source: default` when
   there is no better current source.

It does not switch existing branches, rename worktrees, or override an explicit `--from`.

### Supported layouts

The recommended flat standalone workspace is called
[Ygg Flow](worktrees.md#ygg-flow). It uses `paths.worktrees: ..`:

```text
project/
├── .ygg/workspace.yml
├── .ygg/project.yml         optional local automation and overrides
├── .ygg/shared/
├── repo.git/
├── main/
└── feature-payment/
```

A grouped standalone workspace uses a child path such as `paths.worktrees: ../worktrees`:

```text
project/
├── .ygg/workspace.yml
├── .ygg/project.yml         optional local automation and overrides
├── .ygg/shared/
├── repo.git/
└── worktrees/
    ├── main/
    └── feature-payment/
```

For standalone workspaces, `paths.worktrees` must resolve to the workspace root or one of its
descendants and must not overlap `.ygg` or `repo.git`. Use `--worktrees-dir` during `ygg init` rather
than editing generated paths manually.

When an existing checkout is retained, the worktree directory may be any safe directory outside
the Git directory and primary checkout. The physical configuration and shared files live below
`<git-common-dir>/ygg`; the worktree container contains a `.ygg` link to them. `ygg config` prints the
canonical `workspace_config`, `workspace_root`, `worktrees_path`, and `shared_path` for both layouts.
Re-running `ygg init` restores this link and its configured worktree container if either was deleted.

```text
parent/
├── project/                         existing primary checkout
│   └── .git/ygg/
│       ├── workspace.yml
│       ├── project.yml      optional local automation and overrides
│       └── shared/
└── project-worktrees/
    └── .ygg -> ../project/.git/ygg
```

The conceptual shared-versus-local boundary is shown in
[Shared and independent state](worktrees.md#shared-and-independent-state). A separate workspace
copied from a local repository starts with independent Git object files and does not use local clone
hardlinks.

### Local shared files

Every initialized workspace owns a `.ygg/shared` directory. It is local, created with directory mode
`700`, and never committed. Project automation accesses it only through explicit trusted
`source: shared` steps. Files placed there retain their own permissions; use mode `600` for secrets.
Because these files can contain secrets or other local state, `ygg uninit --apply` refuses to remove
them unless `--force` is also supplied.

## Project configuration

Ygg resolves one effective configuration from two optional sources:

1. `<worktree>/.ygg.yml` is the repository-owned base and may vary by branch or revision.
2. `<workspace>/.ygg/project.yml` is local to one Ygg workspace and overrides that base for every
   worktree.

In an adopted workspace the local file physically lives at
`<git-common-dir>/ygg/project.yml`. It is mode `600`, is never committed, and is protected as local
data during `ygg uninit`. If only one source exists, it supplies the complete effective behavior.

Generate the recommended local starting point from detected Node package conventions:

```sh
ygg config init [worktree]
```

Create shared repository behavior only when intended:

```sh
ygg config init [worktree] --scope project
git diff -- .ygg.yml
```

The wizard detects npm, pnpm, Yarn, or Bun, package scripts, and files such as `.env.example`. It can
add an install hook, an environment copy step, a `verify` task, a separate `dev` task for an exact
`dev` package script, and a default tool. The long-running `dev` script is never added to the
one-shot `verify` task. Interactive setup asks whether to create the `verify` task before offering
individual scripts; declining or selecting no scripts omits the task.

For workspace scope, the generator writes a sparse overlay: hooks and tasks that were not selected
are omitted, so existing repository behavior remains inherited. The explicit `--from-project` path
is the only generator mode that intentionally copies the complete repository configuration.

`Esc` returns to the preceding wizard step and restores the previous answer as its default;
`Ctrl-C` exits Ygg. Selection prompts list both shortcuts in their footer. From the final preview,
going back returns to the tool choice without discarding the other detected setup decisions.

For scripts, use `ygg config init --yes`; use `--force` separately when existing configuration at
the selected scope may be replaced. `--yes` keeps the detected recommended verify scripts.
Interactive `ygg init` offers the same wizard after retaining a checkout or creating the default
worktree in a standalone workspace and recommends local storage. Automatic project detection
currently covers Node package managers; other ecosystems use manually configured commands.

During guided initialization this wizard is presented as a separate optional phase after the
workspace and, for standalone layouts, the first worktree are ready. Cancelling it does not roll back
the initialized workspace.

When `.ygg.yml` already exists, copy its complete normalized behavior into the local workspace with:

```sh
ygg config init [worktree] --scope workspace --from-project --yes
```

The source `.ygg.yml` remains in place and continues as the repository base until deliberately
removed. Copying it locally and then removing the source preserves the semantic behavior hash when
the effective configuration is unchanged. Ygg never deletes, commits, or pushes `.ygg.yml`.

The repository-owned `.ygg.yml` supports this complete top-level schema:

```yaml
version: 1
defaults:
  fetch: true
  tool: code
hooks:
  pre_create: []
  post_create: []
  pre_remove: []
  post_remove: []
tasks: {}
tools: {}
```

Every section except `version` is optional and receives the defaults above.

The local `project.yml` uses the same fields as a partial overlay. Only fields present locally
override the repository base:

```yaml
version: 1
defaults:
  tool: null
hooks:
  post_create: []
tasks:
  inherited-task: null
  local-check:
    steps:
      - type: command
        argv: [pnpm, test]
tools:
  inherited-tool: null
```

| Local value | Merge behavior |
| --- | --- |
| `defaults.fetch` or `defaults.tool` | Override that field only; `tool: null` clears the inherited default. |
| `hooks.<event>` | Replace the complete inherited hook; `[]` disables it. |
| `tasks.<name>` | Add or replace that named task; `null` removes an inherited task. |
| `tools.<name>` | Add or replace that named tool; `null` removes an inherited tool. |

The effective result, not either source file in isolation, owns execution and trust.

| Field | Default | Purpose |
| --- | --- | --- |
| `version` | required `1` | Project schema version. |
| `defaults.fetch` | `true` | Fetch the configured remote before resolving branches. |
| `defaults.tool` | none | Editor or agent profile used by `ygg open`/`ygg create --open`. |
| `hooks.pre_create` | `[]` | Steps before `git worktree add`; no target checkout exists yet. |
| `hooks.post_create` | `[]` | Installation and local-file setup after checkout creation. |
| `hooks.pre_remove` | `[]` | Project checks that may stop removal before Git changes anything. |
| `hooks.post_remove` | `[]` | Cleanup after Git removed the worktree. |
| `tasks` | `{}` | Named workflows invoked with `ygg run <task>`. |
| `tools` | `{}` | Project-specific editor or agent profiles. |

### Complete example

This example demonstrates every lifecycle hook, safe argument-array commands, copy/symlink setup,
named tasks, and a custom agent profile. Adapt its project-specific paths before using it:

```yaml
version: 1

defaults:
  fetch: true
  tool: codex

hooks:
  pre_create:
    - type: command
      argv: [node, -e, "process.exit(process.env.YGG_BRANCH ? 0 : 1)"]
      cwd: workspace
      timeout_seconds: 30

  post_create:
    - type: command
      argv: [pnpm, install, --frozen-lockfile]
      cwd: target
      timeout_seconds: 600
    - type: copy
      source: default
      from: config/local.example.json
      to: .local/config.json
      optional: true
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .
      optional: true

  pre_remove:
    - type: command
      argv: [node, scripts/check-worktree-removal.mjs]
      cwd: target

  post_remove:
    - type: command
      argv: [node, -e, "console.log(process.env.YGG_BRANCH)"]
      cwd: workspace
      continue_on_error: true

tasks:
  verify:
    description: Run all checks before review
    steps:
      - type: command
        argv: [pnpm, run, lint]
      - type: command
        argv: [pnpm, run, typecheck]
      - type: command
        argv: [pnpm, run, test]
        timeout_seconds: 900

  dev:
    description: Start the local development process
    steps:
      - type: command
        argv: [pnpm, run, dev]

tools:
  review-agent:
    description: Start Codex with the repository review profile
    command: [codex, --profile, review]
    mode: foreground
```

### Command steps

Argument arrays are the default and do not invoke a shell:

```yaml
- type: command
  argv: [pnpm, install, --frozen-lockfile]
  cwd: target
  env:
    CI: "false"
  timeout_seconds: 600
  continue_on_error: false
```

Use `shell` only when shell syntax is intentional. It always executes as `/bin/sh -c` and cannot be
combined with `argv`:

```yaml
- type: command
  shell: pnpm build && cp dist/app "$YGG_WORKTREE_PATH/.local/app"
```

`cwd` accepts `source`, `target`, or `workspace`. Its default is source for `pre_create`, workspace
for `post_remove`, and target otherwise. Commands receive:

During `pre_create`, the target worktree does not exist yet. On the first checkout of a standalone
workspace there may also be no source worktree, so repository-local helper scripts should run in
`post_create` or use a source that is known to exist.

- `YGG_EVENT`: hook name or `task:<name>`
- `YGG_WORKSPACE_ROOT`
- `YGG_SOURCE_PATH`
- `YGG_WORKTREE_PATH`
- `YGG_BRANCH`

| Field | Default | Purpose |
| --- | --- | --- |
| `type` | required `command` | Selects command execution. |
| `argv` | none | Argument-safe executable and arguments; mutually exclusive with `shell`. |
| `shell` | none | Intentional `/bin/sh -c` expression; mutually exclusive with `argv`. |
| `cwd` | event-dependent | `source`, `target`, or `workspace`. |
| `env` | `{}` | Additional string environment variables. |
| `timeout_seconds` | none | Positive timeout, up to one day. |
| `continue_on_error` | `false` | Warn and continue with the next step after a failure. |

### File steps

`copy` and `symlink` are available in `post_create` and named tasks:

```yaml
- type: copy
  source: default
  from: .env.example
  to: .env
  optional: true
  on_existing: skip

- type: symlink
  source: primary
  from: .local/cache
  to: .local/cache

- type: symlink
  source: shared
  from: env
  glob: "**/.env*"
  to: .
```

| Source | Resolves to | Typical use |
| --- | --- | --- |
| `current` | Worktree from which the command was invoked | Carry a worktree-local file into another checkout. It may be unavailable from the workspace root. |
| `default` | Worktree on `default_branch` | Copy committed templates or stable local files from the main development checkout. |
| `primary` | Original protected checkout | Reuse local files after keeping an existing checkout. It is unavailable in standalone bare workspaces. |
| `shared` | Local `.ygg/shared` directory | Central `.env`, credentials, caches, or editor configuration shared across worktrees. |

| Field | Default | Purpose |
| --- | --- | --- |
| `type` | required | `copy` creates an independent snapshot; `symlink` keeps one live central file. |
| `source` | `default` | Selects one of the roots above. |
| `from` | required | Relative file/directory, or the source directory used with `glob`. |
| `glob` | none | One positive relative pattern evaluated below `from`; matched file paths are preserved below `to`. |
| `to` | required | Exact target without `glob`; target directory with `glob`. |
| `optional` | `false` | Skip a missing exact source or a glob with no file matches. |
| `on_existing` | `error` | Handle a conflicting target with `error`, `skip`, or `replace`. |
| `overwrite` | none | Legacy alias: `false` means `error`, `true` means `replace`. Do not combine it with `on_existing`. |
| `continue_on_error` | `false` | Warn and continue after a failed file step. |

Source and target paths must be relative and remain inside their configured roots after resolving
symlinks. Copy rejects symlinks anywhere inside a copied tree. Generated symlinks use relative
targets, so a complete workspace remains relocatable.

Without `glob`, `from` and `to` retain their exact file-or-directory behavior. With `glob`, `from`
must be a directory and only matches that resolve to files are processed. The pattern cannot be
absolute, negated, or contain a `..` path segment. Directories are not independent matches.

All matches and destinations are sorted and validated before the first target is changed. A symlink
that already resolves to the intended real source is idempotent and reports `UNCHANGED`, even with
the default policy. Other existing files, directories, or different and broken symlinks follow
`on_existing`: `error` preserves the complete step and fails, `skip` preserves only conflicting
targets while processing the rest, and `replace` removes and recreates them. There is deliberately
no runtime `--force` for automation; replacement stays part of the reviewed and trusted behavior.

A glob `copy` rejects matched source symlinks. A glob `symlink` may resolve a source symlink only
when its target is a file inside the configured source root. `continue_on_error` applies to the
complete multi-file step. Legacy `overwrite` remains accepted, and equivalent legacy/new policies
produce the same semantic trust hash.

For centrally edited monorepo environment files, preserve their repository-relative structure:

```yaml
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .
```

The source-relative portion below `env` becomes the target-relative path, producing `.env`,
`apps/api/.env`, and `apps/web/.env.local`. Editing a shared source updates every symlink
immediately. A copied target changes only after the corresponding named task or `ygg setup` runs
again; `ygg hook run post_create` is the equivalent general hook command. Because file steps can
expose local data, their exact paths and glob patterns participate in the same project-configuration
trust hash as commands.

Every non-empty automation run reports its selected worktree, branch, target path, and one status
row per command or file operation:

```text
Hook        post_create
Worktree    feature-payment
Branch      feature/payment
Path        /workspace/feature-payment

STEP  STATUS     TYPE      SOURCE / COMMAND                    TARGET / CWD                  NOTE
1     RUNNING    command   pnpm install --frozen-lockfile      /workspace/feature-payment
1     DONE       command   pnpm install --frozen-lockfile      /workspace/feature-payment

2     RUNNING    symlink   shared:env/.env                     target:.env
2     UNCHANGED  symlink   shared:env/.env                     target:.env                   already linked

3     RUNNING    symlink   shared:env/local                    target:.local
3     SKIPPED    symlink   shared:env/local                    target:.local                 target exists

4     RUNNING    copy      default:config.example              target:config.local
4     REPLACED   copy      default:config.example              target:config.local           existing target
```

Each lifecycle hook receives its own labeled block; consecutive hooks are separated by a blank
line. Named tasks use the same layout with a `Task` heading. Within either block, every configured
step forms a separate group: `RUNNING` is printed before validation or execution, followed by the
result. Glob results remain together under their shared step number.

Command argument arrays retain visible argument boundaries; shell expressions show the actual
`/bin/sh -c` invocation and the resolved working directory. Child output remains unmodified between
`RUNNING` and the result. Environment values are never printed or expanded.

File operations report `CREATED`, `UNCHANGED`, `SKIPPED`, `REPLACED`, or `FAILED` after their
`RUNNING` row, with scoped source and target paths. Glob results remain sorted. Optional missing
sources and empty globs use `SKIPPED` with `source not found`, `source unavailable`, or
`no files matched` in the note. A target conflict under the default policy uses `FAILED` and points
to `on_existing: skip|replace`; `continue_on_error` adds `continuing` before the next step begins.

Non-optional missing sources and empty globs remain errors. Statuses, worktree and branch names, and
paths are colored in a terminal while redirected output remains readable plain text.

### Lifecycle

Creation runs in this order:

```text
resolve branch/config -> trust -> pre_create -> git worktree add -> post_create
```

Removal runs:

```text
safety inspection -> trust -> pre_remove -> git worktree remove -> post_remove
```

```mermaid
flowchart LR
    subgraph Creation
      C1[Resolve repository base and local overrides] --> C2[Validate and trust]
      C2 --> C3[pre_create]
      C3 --> C4[git worktree add]
      C4 --> C5[post_create]
      C5 --> C6[Ready]
      C5 -- Failure --> C7[Kept for ygg setup]
    end

    subgraph Removal
      R1[Inspect safety] --> R2[Validate and trust]
      R2 --> R3[pre_remove]
      R3 --> R4[git worktree remove]
      R4 --> R5[post_remove]
      R3 -- Failure --> R6[Worktree preserved]
      R5 -- Failure --> R7[Removal kept and failure reported]
    end
```

`pre_create` failure leaves no new worktree. `post_create` failure keeps the worktree and reports
`ygg setup <worktree>` for recovery. A `pre_remove` failure preserves the worktree.

### Run hooks manually

After changing `.ygg/project.yml` or `.ygg.yml`, inspect and trust the effective behavior from the
target worktree, then run the hook explicitly:

```sh
cd feature-payment
ygg config
ygg config trust --yes
ygg hook run post_create
```

`ygg hook run <event> [worktree]` accepts all four lifecycle events and reloads both configuration
sources for every invocation. If the edit changes executable behavior, the semantic hash changes
and Ygg requires a new trust decision. Formatting-only changes keep existing trust valid.

Manual execution never performs `git worktree add` or `git worktree remove`. It uses the selected
existing worktree as `YGG_WORKTREE_PATH`; the normal working-directory defaults still apply:
`pre_create` uses the preferred source, `post_remove` uses the workspace, and the other events use
the target. Because `pre_create` normally runs before the target exists and `post_remove` normally
runs after it is gone, Ygg warns that manual runs of these two events simulate a different lifecycle
state. `ygg setup [worktree]` remains a compatibility shortcut for manually running `post_create`.

### Named tasks and tool profiles

```yaml
tasks:
  verify:
    description: Run checks used before review
    steps:
      - type: command
        argv: [pnpm, lint]
      - type: command
        argv: [pnpm, test]

tools:
  app-agent:
    description: Start an agent with the app profile
    command: [codex, --profile, app]
    mode: foreground
```

Run these with `ygg run verify [worktree]` and `ygg open [worktree] --tool app-agent`. Tool arguments
may contain `{path}`; the selected worktree is also the process working directory. `mode` is
`foreground` or `detached`.

| Field | Default | Purpose |
| --- | --- | --- |
| `tasks.<name>.description` | none | Human-readable text shown during interactive task selection. |
| `tasks.<name>.steps` | required, non-empty | Ordered command/copy/symlink steps executed by `ygg run`. |
| `tools.<name>.description` | none | Human-readable editor or agent description. |
| `tools.<name>.command` | required, non-empty | Argument array used to start the tool; `{path}` expands to the selected worktree. |
| `tools.<name>.mode` | `foreground` | `foreground` waits and returns its exit status; `detached` starts independently. |

Long-running tasks such as `ygg run dev` stream their output in the foreground. `Ctrl-C` stops the
child process and exits with status 130 without reporting the interruption as a configuration
failure.

Built-in profiles are `code`, `cursor`, `zed`, `codex`, `codex-app`, and `claude`; unavailable
commands are omitted from interactive selection.

## Trust

Any non-empty effective hook, task, or custom tool makes project configuration executable. Ygg
hashes the merged, validated, normalized behavior with SHA-256. Comments, whitespace, mapping order,
and moving identical behavior between `.ygg.yml` and `.ygg/project.yml` do not change trust;
behavioral changes in either source do.

```sh
ygg config
ygg config trust --yes
ygg config untrust --yes
```

For a standalone workspace without a checkout, these commands combine local `project.yml` with
`.ygg.yml` read directly from the configured default branch or revision.
