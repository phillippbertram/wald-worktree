# Repository Instructions

This file is the canonical source of repository-wide instructions for coding agents and automated
contributors. Keep it agent-agnostic. Tool-specific compatibility files must point here instead of
duplicating these rules.

## Project Context

Ygg is a configurable Git worktree and agent-workflow CLI. It creates, discovers, prepares, opens,
automates, and safely removes worktrees while keeping Git as the underlying source of truth.

Safety, deterministic behavior, and useful non-interactive commands are part of the product
contract. A change that weakens a preview, confirmation, trust check, path boundary, or preservation
guarantee is a behavior change, even if the public command shape stays the same.

Use English for source code, identifiers, comments, documentation, tests, commit messages, and
user-facing CLI text.

## Sources of Truth

- `package.json` owns the supported runtime, package manager, dependencies, and project scripts.
- `src/cli/` owns commands, option parsing, input validation, and interactive orchestration.
- `src/domain/` owns shared domain contracts and expected domain errors.
- `src/services/` owns workflows and business behavior.
- `src/infrastructure/` owns Git, process, filesystem, and path boundaries.
- `src/ui/` owns terminal prompts and presentation, not repository mutation rules.
- `tests/` owns executable behavior and regression coverage.
- `README.md` owns the product overview and first-use journey.
- `docs/` owns detailed CLI, configuration, worktree, and agent-workflow documentation.
- `skills/ygg-worktrees/` owns the portable skill for agents using Ygg in other repositories.

Inspect the relevant implementation, tests, and documentation before changing behavior. Do not
infer current behavior from a single source when an executable contract is available.

## Toolchain and Commands

Requirements:

- Node.js 22.13.0 or newer.
- pnpm 11.15.1, as pinned by `packageManager`.
- Git.

Use pnpm for all package operations. Do not introduce npm, Yarn, or Bun lockfiles.

```sh
pnpm install
pnpm dev -- --help
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm run ci
```

- `pnpm dev -- <arguments>` runs the CLI from TypeScript source.
- `pnpm test -- <test-file>` runs focused Vitest coverage.
- `pnpm run ci` is the canonical full validation: lint, typecheck, tests, and build.
- `pnpm lint:fix` rewrites files. Do not run it across a dirty worktree unless every resulting
  change is in scope. Prefer formatting only files owned by the current task.
- `dist/` is generated and ignored. Never edit or commit it manually.

Do not add or upgrade dependencies unless the requested change needs them. Explain the need and
keep both manifest and lockfile consistent when a dependency change is in scope.

## Working Agreement

1. Inspect `git status --short` and the relevant diff before editing.
2. Treat existing modified, staged, and untracked files as someone else's work unless the task
   explicitly places them in scope.
3. Make the smallest cohesive change that satisfies the request. Avoid opportunistic refactors.
4. Preserve backward compatibility unless the request explicitly calls for a clean break.
5. Run focused validation while iterating, then run the full relevant validation before handoff.
6. Review the final diff and status so generated or unrelated files are not included.

Do not stage, commit, amend, rebase, merge, push, publish, or open a pull request unless explicitly
requested. If a commit is requested, use an English Conventional Commit subject such as
`feat(cli): add command` and include only the intended files.

Never discard existing work or use destructive Git operations such as `git reset --hard` or forced
checkout without explicit permission. Do not delete worktrees, branches, repositories, shared
files, or local configuration based on an inferred cleanup request.

## Architecture Rules

- Keep command handlers thin. They may parse input, coordinate services, and render results, but
  must not reimplement Git, filesystem, trust, or lifecycle rules.
- Keep terminal UI functions focused on prompts and presentation. Put reusable decisions and state
  transitions in services so interactive and non-interactive paths share behavior.
- Keep Git and external-process execution behind infrastructure abstractions. Do not scatter raw
  process invocation through commands or UI code.
- Keep shared domain types independent of Commander, Inquirer, terminal formatting, and concrete
  process implementations.
- Prefer explicit dependencies through the existing CLI context and service constructors over
  hidden global state.
- Preserve a single behavioral path for guided and direct commands wherever possible. A safety
  check must not exist only in the interactive flow.

## TypeScript and CLI Conventions

- This repository uses strict TypeScript, ESM, NodeNext module resolution, and ES2024.
- Use `.js` extensions for relative imports from TypeScript source.
- Prefer precise types, discriminated unions, and `unknown` plus validation over `any` or unsafe
  assertions.
- Respect `noUncheckedIndexedAccess`; handle missing values explicitly.
- Use Zod at untrusted CLI and configuration boundaries and produce readable user-facing errors.
- Use `YggError` for expected operational failures that should be presented without an internal
  stack trace.
- Pass external commands as an executable plus explicit argument array. Do not introduce shell
  interpolation or expansion for user- or configuration-provided values.
- Keep output deterministic. Preserve documented exit codes, JSON shapes, help text, and non-TTY
  behavior unless the task explicitly changes the public contract.
- Keep option definitions, validation, interactive prompts, completion data, tests, and
  documentation synchronized when the command surface changes.
- Use Biome as the formatting and linting authority. Follow the existing two-space indentation,
  double quotes, semicolons, trailing commas, and 100-column preference.

## Safety and Trust Boundaries

- Treat repository URLs, paths, branch names, `.ygg.yml` contents, and subprocess output as
  untrusted input.
- Validate paths before writes. Copy and symlink operations must not escape their allowed source or
  destination roots through `..`, absolute paths, or symbolic-link traversal.
- Preserve the `.ygg.yml` trust model. Executable hooks, tasks, and tools require an explicit local
  trust decision; declarative configuration alone must not silently execute code.
- Keep destructive workflows preview-first. Applying removal, pruning, or uninitialization must
  require the documented explicit confirmation flags in non-interactive use.
- `--force` may bypass only the documented safety condition. It must never imply permission to
  delete branches, the primary checkout, unrelated directories, or shared user data.
- Preserve user repositories, remotes, Git configuration, dirty files, stashes, locks, and
  incomplete work unless the command contract and user confirmation explicitly allow a mutation.
- Never use real credentials, private repository URLs, personal environment files, or home-directory
  data in source, fixtures, snapshots, examples, logs, or issue text.
- Redact tokens, credentials, environment-file contents, and sensitive repository locations from
  errors or shared diagnostics.

## Testing Rules

- Add or update tests for every behavior change and bug fix.
- Use focused unit tests for parsing, validation, rendering, and deterministic domain decisions.
- Use integration tests with temporary repositories for Git, filesystem, worktree, configuration,
  process, and end-to-end CLI behavior.
- Never run mutation tests against a developer's real repository, global Git configuration, shell
  profile, or home directory.
- Cover both successful behavior and the relevant safety boundary: invalid input, cancellation,
  dirty state, trust rejection, partial failure, interruption, or cleanup.
- Preserve state in failure tests. Assert what remains after an interrupted or rejected operation,
  not only the reported error.
- Update snapshots only when the public output intentionally changes, and review the snapshot diff.
- For command-surface changes, cover direct invocation, help or completion contracts, and guided
  navigation when each path is affected.

Run the smallest relevant test file first. Before handoff, run `pnpm run ci` when code or executable
behavior changed. For documentation-only changes, inspect links and run whitespace/diff checks; full
application tests are optional. Report commands that were not run or failures that are unrelated to
the task.

## Documentation Rules

- Update documentation in the same change when user-visible behavior, flags, output, defaults,
  safety guarantees, configuration, or workflows change.
- Keep `README.md` concise and task-oriented. Put detailed reference material in the matching file
  under `docs/` and link to it instead of duplicating long explanations.
- Keep `docs/cli-reference.md` aligned with the shipped command surface.
- Keep `docs/configuration.md` aligned with the accepted `.ygg.yml` schema and trust behavior.
- Keep `docs/worktrees.md` aligned with workspace layouts, lifecycle, and Git semantics.
- Keep `docs/agent-workflows.md` aligned with supported multi-worktree agent usage.
- Update `skills/ygg-worktrees/` when a change affects how external agents should discover or safely
  operate Ygg. Keep the default skill short and route detail to its reference files.
- Document only implemented behavior. Clearly label roadmap or proposed behavior and do not present
  it as available.
- Maintain one canonical owner per topic. Prefer links over repeated text that can drift.

## Handoff

At completion, summarize the user-visible outcome, list the validation performed, and call out any
remaining risk or skipped check. Do not claim a check passed unless it was run successfully. Leave
the worktree with unrelated pre-existing changes untouched.
