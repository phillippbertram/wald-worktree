#!/usr/bin/env python3
"""Record real Wald sessions in disposable repositories, or check their transcripts."""

import argparse
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
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "apps/docs/public/demos"
MANIFEST = ROOT / "apps/docs/lib/demos.generated.json"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
WIDTHS = {"compact": 64, "wide": 104}
ROWS = 19
# The recorder enables color and Clack renders this footer at the end of an active prompt.
PROMPT_FOOTER = "\n\x1b[36m└\x1b[39m".encode("utf-8")


class PromptInput(NamedTuple):
    title: str
    keys: bytes
    end: bytes = PROMPT_FOOTER + b"\r\n"


def plain(text):
    return ANSI.sub("", text).replace("\r", "")


def readable(text):
    """Separate overwritten frames and keep the rendered lines for the text transcript."""
    text = ANSI.sub(lambda match: "" if match[0].endswith("m") else "\n", text)
    return "\n".join(re.sub(r" {2,}", "  ", line.strip()) for line in text.splitlines())


class Fixture:
    def __init__(self, root):
        self.root = root
        self.workspace = root / "canopy"
        self.main = self.workspace / "main"
        home = root / "home"
        home.mkdir()
        node = shutil.which("node")
        git = shutil.which("git")
        if not node or not git:
            raise RuntimeError("Install Node.js and Git before recording.")
        self.wald = [node, str(ROOT / "apps/cli/dist/cli.js")]
        self.env = {
            "PATH": os.pathsep.join([str(Path(node).parent), str(Path(git).parent), os.defpath]),
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Wald Demo",
            "GIT_AUTHOR_EMAIL": "demo@example.invalid",
            "GIT_COMMITTER_NAME": "Wald Demo",
            "GIT_COMMITTER_EMAIL": "demo@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
            "LC_ALL": "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8",
            "TERM": "xterm-256color",
            "FORCE_COLOR": "1",
            "TMPDIR": str(root),
        }
        remote = root / "remote.git"
        source = root / "source"
        self.run(["git", "init", "--bare", "-b", "main", str(remote)], root)
        self.run(["git", "init", "-b", "main", str(source)], root)
        (source / "README.md").write_text("# Canopy\n", encoding="utf-8")
        (source / "prepare.mjs").write_text(
            'import { writeFileSync } from "node:fs";\n'
            'writeFileSync("local-settings.json", "{}\\n");\n'
            'console.log("Local settings prepared");\n',
            encoding="utf-8",
        )
        (source / ".gitignore").write_text("local-settings.json\n", encoding="utf-8")
        self.run(["git", "add", "."], source)
        self.run(["git", "commit", "-m", "Seed Canopy"], source)
        self.run(["git", "push", str(remote), "main"], source)
        self.run([*self.wald, "init", str(remote), str(self.workspace)], root)
        self.create("main")

    def run(self, argv, cwd):
        return subprocess.run(
            argv, cwd=cwd, env=self.env, check=True, capture_output=True, timeout=20
        )

    def create(self, branch):
        self.run([*self.wald, "create", branch, "--no-fetch"], self.workspace)

    def normalize(self, text):
        return text.replace(str(self.root), "/demo")


def capture(fixture, argv, cwd, width, inputs, expected):
    """Yield output at prompt boundaries, retaining terminal control sequences."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, width, 0, 0))
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=fixture.env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
    )
    os.close(slave)

    def read_until(prompt=None):
        output = bytearray()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                if prompt:
                    transcript = fixture.normalize(plain(output.decode(errors="replace")))
                    raise AssertionError(
                        f"Wald exited before {prompt.title!r} finished rendering: {transcript}"
                    )
                return fixture.normalize(output.decode())
            output.extend(chunk)
            # A PTY read can stop anywhere, even inside a UTF-8 character or escape sequence.
            if prompt and output.endswith(prompt.end):
                frame = output.decode()
                if prompt.title in plain(frame):
                    return fixture.normalize(frame)
        target = f"{prompt.title!r} to finish rendering" if prompt else "Wald to exit"
        transcript = fixture.normalize(plain(output.decode(errors="replace")))
        raise TimeoutError(f"Timed out waiting for {target}: {transcript}")

    try:
        for prompt in inputs:
            yield read_until(prompt)
            os.write(master, prompt.keys)
        yield read_until()
        assert process.wait(timeout=5) == expected, (argv, process.returncode)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        os.close(master)


class Recording:
    def __init__(self, fixture, width):
        self.fixture = fixture
        self.width = width
        self.events = []
        self.chapters = []
        self.time = 0.1

    def frame(self, text):
        self.events.append([round(self.time, 2), "o", text])

    def chapter(self, title, description, command, frames, snippets):
        start = round(self.time + 0.15, 2)
        for frame in frames:
            self.frame(frame)
            self.time += 0.6
        output = readable("".join(frames))
        excerpts = []
        for snippet in snippets:
            matching = next((line.strip() for line in output.splitlines() if snippet in line and "█" not in line), None)
            assert matching, f"Expected {snippet!r} in {title}:\n{output}"
            if matching not in excerpts:
                excerpts.append(matching)
        self.chapters.append({
            "time": start, "seek": round(self.time - 0.45, 2),
            "title": title, "description": description,
            "command": command, "lines": excerpts,
        })
        self.time += 3.1

    def command(self, title, description, command, snippets, cwd=None, inputs=(), expected=0):
        frames = list(capture(
            self.fixture, [*self.fixture.wald, *command.split()[1:]],
            cwd or self.fixture.workspace, self.width, inputs, expected,
        ))
        self.chapter(
            title, description, command,
            [f"\x1b[2J\x1b[H\x1b[1;32m❯\x1b[0m {command}\r\n", *frames],
            snippets,
        )

    def cast(self):
        self.frame("\x1b[?25l")
        header = {"version": 2, "width": self.width, "height": ROWS}
        return "\n".join(json.dumps(item, ensure_ascii=False) for item in [header, *self.events]) + "\n"


def guided(fixture, width):
    config = fixture.workspace / ".wald/project.yml"
    config.write_text(
        "version: 1\ndefaults:\n  fetch: false\nhooks:\n  post_create:\n"
        "    - type: command\n      argv: [node, prepare.mjs]\n",
        encoding="utf-8",
    )
    fixture.run([*fixture.wald, "config", "trust", "--yes"], fixture.workspace)
    session = Recording(fixture, width)
    inputs = [
        PromptInput("What would you like to do?", b"\r"),
        # Clack's autocomplete prompt does not emit a newline after the footer.
        PromptInput("Select a branch or create a new one:", b"\r", end=PROMPT_FOOTER),
        PromptInput("Branch name:", b"feature/search\r"),
        PromptInput("Create › Review · Ready to create?", b"\r"),
        PromptInput("What next?", b"\r"),
        PromptInput("What would you like to do?", b"\x1b"),
    ]
    frames = iter(capture(fixture, fixture.wald, fixture.main, width, inputs, 0))
    session.chapter(
        "Open Wald", "The menu opens in Canopy’s main worktree.", "wald",
        ["\x1b[1;32m❯\x1b[0m wald\r\n", next(frames)],
        ["🌲", "Where Git worktrees grow.", "Workspace canopy", "What would you like to do?",
         "Create worktree", "Worktrees…", "Project tasks…", "Project settings…", "Maintenance & diagnostics…"],
    )
    session.chapter(
        "Review the plan", "Wald resolves the branch, destination and project setup before creating files.",
        "", [next(frames), next(frames), next(frames)],
        ["Branch name:", "Create plan", "feature/search", "Ready to create?"],
    )
    session.chapter(
        "Prepare the worktree", "Wald runs the trusted setup and offers to open the new checkout.",
        "", list(frames), ["Local settings prepared", "Created feature-search", "What next?"],
    )
    assert (fixture.workspace / "feature-search/local-settings.json").is_file()
    session.command(
        "Inspect the result", "Use -C to inspect the new checkout from the workspace root.",
        "wald -C feature-search status", ["Current", "Worktrees"],
    )
    return session


def parallel(fixture, width):
    session = Recording(fixture, width)
    session.command(
        "Make room for API work", "The API task gets a separate checkout and index.",
        "wald create feature/api", ["Created feature-api", "Upstream:"],
    )
    session.command(
        "Make room for UI work", "The UI task has its own folder while the API checkout stays available.",
        "wald create feature/ui", ["Created feature-ui", "Upstream:"],
    )
    session.command(
        "See both checkouts", "Use the listed paths to open each agent in its assigned worktree.",
        "wald list", ["feature/api", "feature/ui"],
    )
    assert (fixture.workspace / "feature-api/README.md").is_file()
    assert (fixture.workspace / "feature-ui/README.md").is_file()
    return session


def handoff(fixture, width):
    fixture.create("feature/search")
    source = fixture.workspace / "feature-search"
    readme = source / "README.md"
    readme.write_text("# Canopy search\n", encoding="utf-8")
    fixture.run(["git", "add", "README.md"], source)
    readme.write_text("# Canopy search\n\nDraft ranking notes.\n", encoding="utf-8")
    (source / "notes.txt").write_text("Try prefix matching.\n", encoding="utf-8")
    session = Recording(fixture, width)
    session.command(
        "Check the source", "The original checkout has staged, unstaged and untracked work.",
        "wald -C feature-search status", ["Current"],
    )
    session.command(
        "Copy the code", "Wald starts a fresh branch at the source commit and copies its local changes.",
        "wald -C feature-search handoff feature/review", ["Carried:", "Source kept unchanged:"],
    )
    session.command(
        "Check the target", "Both folders contain the changes. Open a fresh session in the review worktree.",
        "wald -C feature-review status", ["Current"],
    )
    target = fixture.workspace / "feature-review"
    for checkout in [source, target]:
        status = fixture.run(["git", "status", "--porcelain=v1"], checkout).stdout
        assert status == b"MM README.md\n?? notes.txt\n", status
        assert (checkout / "notes.txt").read_text(encoding="utf-8") == "Try prefix matching.\n"
        assert (checkout / "README.md").read_text(encoding="utf-8") == readme.read_text(encoding="utf-8")
    return session


def cleanup(fixture, width):
    fixture.create("feature/search")
    fixture.create("review/ui")
    dirty = fixture.workspace / "feature-search/README.md"
    dirty.write_text("Unfinished search\n", encoding="utf-8")
    session = Recording(fixture, width)
    session.command(
        "Protect unfinished work", "Wald rejects removal because the checkout contains local changes.",
        "wald remove feature-search", ["contains staged, unstaged, or untracked changes"], expected=1,
    )
    assert dirty.read_text(encoding="utf-8") == "Unfinished search\n"
    session.command(
        "Review the removal", "The clean review checkout is eligible. The menu starts on Cancel.",
        "wald remove review-ui", ["Removal plan", "Remove worktree, keep branches", "Branch kept:"],
        inputs=[PromptInput("Remove › Action · What would you like to do?", b"\x1b[B\r")],
    )
    session.command(
        "Check what remains", "The review directory is gone and the modified search checkout remains.",
        "wald list", ["feature/search", "modified"],
    )
    assert not (fixture.workspace / "review-ui").exists()
    fixture.run(["git", "show-ref", "--verify", "refs/heads/review/ui"], fixture.main)
    return session


SCENARIOS = {"create": guided, "parallel": parallel, "handoff": handoff, "cleanup": cleanup}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare observed transcripts with the recorded demos")
    args = parser.parse_args()
    if not (ROOT / "apps/cli/dist/cli.js").is_file():
        raise SystemExit("Build Wald with pnpm build before recording.")
    previous = json.loads(MANIFEST.read_text(encoding="utf-8")) if args.check else {}
    if not args.check:
        ASSETS.mkdir(parents=True, exist_ok=True)
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    demos = {}
    for name, scenario in SCENARIOS.items():
        demos[name] = {}
        for size, width in WIDTHS.items():
            with tempfile.TemporaryDirectory(dir="/tmp", prefix="w-") as directory:
                fixture = Fixture(Path(directory).resolve())
                session = scenario(fixture, width)
                chapters = session.chapters
                output = ASSETS / f"{name}-{size}.cast"
                data = {"file": output.name, "chapters": chapters}
                if args.check:
                    assert data == previous["demos"][name][size], f"{name} ({size}) changed. Run pnpm docs:demos:record and review the output."
                    cast = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
                    assert cast[0] == {"version": 2, "width": width, "height": ROWS}, output.name
                    assert cast[-1][0] > chapters[-1]["time"], output.name
                    assert all("/private/" not in str(event) and "/tmp/" not in str(event) and "wald-demo-" not in str(event) for event in cast), output.name
                    captured = readable("".join(event[2] for event in cast[1:] if event[1] == "o"))
                    assert all(line in captured for chapter in chapters for line in chapter["lines"]), output.name
                else:
                    recorded = session.cast()
                    assert str(fixture.root) not in recorded and fixture.root.name not in recorded
                    assert "/private/" not in recorded and "/tmp/" not in recorded
                    output.write_text(recorded, encoding="utf-8")
                demos[name][size] = data
        print(f"{'Checked' if args.check else 'Recorded'} {name}", flush=True)
    if not args.check:
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        MANIFEST.write_text(json.dumps({"revision": revision, "demos": demos}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
