# Project automation

`.wt.yml` is repository-owned executable configuration. Validate and inspect it before granting
trust:

```sh
wt config
wt config trust --yes
```

Create a detected starting configuration with `wt config init`. In non-interactive sessions, use
`wt config init <worktree> --yes`; replacing an existing file also requires `--force`.

Run named tasks in the selected worktree:

```sh
wt run <task> <worktree>
```

Prefer tasks over reimplementing their commands because tasks preserve configured order,
environment variables, timeouts, working directories, and failure handling.

`post_create` is the only lifecycle hook with a deliberate manual recovery command:

```sh
wt setup <worktree>
```

Other lifecycle hooks run only as part of `wt create` or `wt remove`; there is no unrestricted
public hook runner.

Command steps using `argv` do not invoke a shell. A configured `shell` step explicitly uses
`/bin/sh -c`; review quoting and expansion accordingly. `copy` and `symlink` steps are restricted to
the target worktree and supported source worktrees.
