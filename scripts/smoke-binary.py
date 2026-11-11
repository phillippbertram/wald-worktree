#!/usr/bin/env python3
"""Exercise a standalone Wald binary in isolated repositories and real Unix PTYs."""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def run(argv, cwd, env, expected=0, clean_stderr=False, allowed_stderr=()):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == expected, (argv, result.returncode, result.stdout, result.stderr)
    if clean_stderr:
        assert result.stderr in ("", *allowed_stderr), (argv, result.stderr)
    return result.stdout


def terminal(argv, cwd, env, steps, expected=0):
    """Wait for each prompt before sending input; always reap the child and its processes."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    process = subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
    )
    os.close(slave)
    transcript = b""
    pending = b""

    def read_until(needle):
        nonlocal transcript, pending
        deadline = time.monotonic() + 20
        while needle not in ANSI.sub("", pending.decode(errors="replace")):
            if time.monotonic() > deadline:
                raise AssertionError(f"Timed out waiting for {needle!r}: {transcript!r}")
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                raise AssertionError(f"Exited before {needle!r}: {transcript!r}")
            transcript += chunk
            pending += chunk
        pending = b""

    try:
        for needle, keys in steps:
            read_until(needle)
            os.write(master, keys)
        # Drain the PTY while waiting, so output cannot fill the terminal buffer.
        deadline = time.monotonic() + 20
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise AssertionError(f"Terminal did not exit: {transcript!r}")
            if select.select([master], [], [], 0.1)[0]:
                try:
                    transcript += os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
        assert process.returncode == expected, (process.returncode, transcript)
        assert b"command not found" not in transcript, transcript
        assert b"not currently executing" not in transcript, transcript
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        os.close(master)


def smoke(binary, root):
    tools = root / "bin"
    tools.mkdir()
    shutil.copy2(binary, tools / "wald")
    required = ["git", "bash", "zsh", "fish"]
    utilities = [
        "uname", "mkdir", "chmod", "rm", "mv", "sed", "awk", "cat", "grep", "sort", "cut", "tr",
        "dirname", "basename", "ls", "head", "tail", "readlink", "expr", "stty", "tput",
    ]
    for name in required + utilities:
        executable = os.environ.get(f"{name.upper()}_BINARY") or shutil.which(name)
        if executable:
            (tools / name).symlink_to(executable)
        elif name in required:
            raise RuntimeError(f"Install {name} or set {name.upper()}_BINARY to its absolute path.")

    home = root / "home"
    home.mkdir()
    env = {
        "PATH": str(tools), "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"),
        "GIT_AUTHOR_NAME": "Wald binary tests", "GIT_AUTHOR_EMAIL": "tests@example.invalid",
        "GIT_COMMITTER_NAME": "Wald binary tests", "GIT_COMMITTER_EMAIL": "tests@example.invalid",
        "TERM": "xterm-256color", "NO_COLOR": "1",
        "LC_ALL": "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8",
        "TMPDIR": str(root),
    }
    assert shutil.which("node", path=env["PATH"]) is None
    assert shutil.which("bun", path=env["PATH"]) is None
    wald = str(tools / "wald")
    assert "Usage: wald" in run([wald, "--help"], root, env)
    assert "Usage: wald" in run([wald], root, env)
    assert run([wald, "--version"], root, env).strip()

    source = root / "source"
    remote = root / "remote.git"
    workspace = root / "Wörk space"
    run(["git", "init", "--bare", str(remote)], root, env)
    run(["git", "init", "-b", "main", str(source)], root, env)
    (source / "README.md").write_text("# Binary fixture\n")
    run(["git", "add", "README.md"], source, env)
    run(["git", "commit", "-m", "test: seed binary fixture"], source, env)
    run(["git", "remote", "add", "origin", str(remote)], source, env)
    run(["git", "push", "-u", "origin", "main"], source, env)
    run(["git", "--git-dir", str(remote), "symbolic-ref", "HEAD", "refs/heads/main"], root, env)
    run([wald, "init", str(remote), str(workspace)], root, env)
    run([wald, "create", "main", "--no-fetch"], workspace, env)
    doctor = json.loads(run([wald, "doctor", "--json"], workspace, env))
    assert any(check["id"] == "runtime.bun" for check in doctor["checks"]), doctor
    print("PASS: relocated binary, non-TTY help, Git lifecycle and doctor without Node/Bun", flush=True)

    # Repository-local Bun files must not introduce implicit configuration or executable code.
    (workspace / ".env").write_text("WALD_PACKAGING_UNTRUSTED=unexpected\n")
    (workspace / "bunfig.toml").write_text('preload = ["./unexpected-preload.js"]\n')
    (workspace / "unexpected-preload.js").write_text(
        'import { writeFileSync } from "node:fs"; writeFileSync("preload-ran", "unexpected");\n'
    )
    run([wald, "exec", "main", "--", "/bin/sh", "-c",
         'test -z "${WALD_PACKAGING_UNTRUSTED+x}"'], workspace, env)
    run([wald, "exec", "main", "--", "/bin/sh", "-c",
         'test "$WALD_PACKAGING_UNTRUSTED" = caller'], workspace,
        {**env, "WALD_PACKAGING_UNTRUSTED": "caller"})
    assert not (workspace / "preload-ran").exists()
    print("PASS: local .env and bunfig.toml do not alter the binary runtime", flush=True)

    # Real keypresses cover selection, autocomplete, text entry, confirmation and navigation.
    terminal([wald], workspace, env, [("What do you want to do?", b"\x1b")])
    terminal([wald], workspace, env, [("What do you want to do?", b"\x03")], expected=130)
    terminal([wald], workspace, env, [
        ("What do you want to do?", b"\r"),
        ("Select a branch or create a new one:", b"\r"),
        ("Branch name:", b"feature/interactive\r"),
        ("Create this worktree?", b"\r"),
        ("What next?", b"\r"),
    ])
    assert (workspace / "feature-interactive" / "README.md").is_file()
    terminal([wald, "create", "--no-fetch"], workspace, env, [
        ("Select a branch or create a new one:", b"\r"),
        ("Branch name:", b"feature/rejected\r"),
        ("Create this worktree?", b"n\r"),
    ])
    assert not (workspace / "feature-rejected").exists()
    assert not run(["git", "--git-dir", str(workspace / "repo.git"), "branch", "--list",
                    "feature/rejected"], workspace, env).strip()
    print("PASS: PTY menu, guided creation, declined confirmation, Escape and Ctrl+C (130)", flush=True)

    for shell in required[1:]:
        shell_env = {**env, "WALD_SMOKE_WORKSPACE": str(workspace)}
        if shell == "fish":
            script = """
command wald completion fish | source
functions -q wald; or exit 1
complete -C 'wald plant --' | string match --quiet -- '--json*'; or exit 2
wald cd main; or exit 3
test "$PWD" = "$WALD_SMOKE_WORKSPACE/main"; or exit 4
wald plant smoke/fish --no-fetch --cd; or exit 5
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-fish"; or exit 6
wald handoff smoke/fish-handoff --no-fetch --cd; or exit 7
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-fish-handoff"; or exit 8
wald cd absent-worktree 2>/dev/null; and exit 9
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-fish-handoff"; or exit 10
"""
            argv = ["fish", "--no-config", "-c", script]
        else:
            prelude = ""
            if shell == "zsh":
                prelude = 'autoload -Uz compinit; compinit -d "$HOME/zcompdump"\n'
            completion = os.environ.get("BASH_COMPLETION_FILE") if shell == "bash" else None
            if completion:
                shell_env["BASH_COMPLETION_FILE"] = str(Path(completion).resolve())
                shell_env["BASH_COMPLETION"] = shell_env["BASH_COMPLETION_FILE"]
                prelude += '. "$BASH_COMPLETION_FILE"\n'
            script = prelude + f"""
eval "$(command wald completion {shell})"
""" + ("complete -p wald >/dev/null\n" if shell == "bash" else "whence -w _wald >/dev/null\n") + f"""
command wald complete -- plant -- | grep -q -- --json || exit 1
wald cd main || exit 2
test "$PWD" = "$WALD_SMOKE_WORKSPACE/main" || exit 3
wald plant smoke/{shell} --no-fetch --cd || exit 4
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-{shell}" || exit 5
wald handoff smoke/{shell}-handoff --no-fetch --cd || exit 6
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-{shell}-handoff" || exit 7
wald cd absent-worktree 2>/dev/null && exit 8
test "$PWD" = "$WALD_SMOKE_WORKSPACE/smoke-{shell}-handoff" || exit 9
"""
            argv = [shell, "--noprofile", "--norc", "-c", script] if shell == "bash" else [shell, "-f", "-c", script]
        run(argv, workspace, shell_env, clean_stderr=True,
            allowed_stderr=("Error: No worktree matches: absent-worktree\n",))
        print(f"PASS: {shell} completion registration/protocol, cd, plant --cd, handoff --cd and failed cd", flush=True)
    terminal(["zsh", "-f", "-i"], workspace, {**env, "PS1": "WALD_SMOKE> "}, [
        ("WALD_SMOKE> ", b'autoload -Uz compinit; compinit -d "$HOME/zcompdump"; eval "$(wald completion zsh)"\r'),
        ("WALD_SMOKE> ", b"wald plant --j\t"),
        ("--json", b"\x15exit\r"),
    ])
    print("PASS: actual Zsh Tab completion in a PTY", flush=True)
    if os.environ.get("BASH_COMPLETION_FILE"):
        completion = str(Path(os.environ["BASH_COMPLETION_FILE"]).resolve())
        terminal(["bash", "--noprofile", "--norc", "-i"], workspace, {
            **env, "PS1": "WALD_SMOKE> ", "BASH_COMPLETION_FILE": completion,
            "BASH_COMPLETION": completion,
        }, [
            ("WALD_SMOKE> ", b'. "$BASH_COMPLETION_FILE"; eval "$(wald completion bash)"\r'),
            ("WALD_SMOKE> ", b"wald plant --j\t"),
            ("--json", b"\x15exit\r"),
        ])
        print("PASS: actual Bash Tab completion in a PTY with bash-completion", flush=True)
    if not os.environ.get("BASH_COMPLETION_FILE"):
        print("NOTE: Bash Tab dispatch needs bash-completion; set BASH_COMPLETION_FILE to test it.", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/smoke-binary.py /absolute/path/to/wald")
    with tempfile.TemporaryDirectory(prefix="wald-binary-smoke-") as directory:
        smoke(Path(sys.argv[1]).resolve(strict=True), Path(directory).resolve())
