#!/usr/bin/env python3
"""Exercise release packaging and install a native archive with simulated GitHub responses."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
INSTALLER = ROOT / "install.sh"
RELEASE = Path(__file__).with_name("release-binaries.sh").resolve()
VERSION = json.loads((ROOT / "apps/cli/package.json").read_text())["version"]
TAG = f"v{VERSION}"
REPOSITORY = "phillippbertram/wald-worktree"
ARCHIVES = [
    f"wald-{platform}-{arch}.tar.gz"
    for platform in ("darwin", "linux")
    for arch in ("arm64", "x64")
]


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wald-release-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls"
        self.env = {
            "PATH": f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(self.root),
            "TMPDIR": str(self.root),
            "CALLS": str(self.calls),
        }

    def mock(self, name, body):
        executable = self.bin / name
        executable.write_text(f"#!/bin/bash\nset -eu\n{body}\n")
        executable.chmod(0o755)
        return executable

    def command(self, *args, **kwargs):
        return subprocess.run(
            args, cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=20, **kwargs
        )

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_failure(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)


class InstallerTest(ReleaseTest):
    def setUp(self):
        super().setUp()
        self.destination = self.root / ".local/bin/wald"
        self.checksums = self.root / "SHA256SUMS"
        self.digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
        self.checksums.write_text(f"{self.digest}  {ARCHIVE.name}\n")
        self.env.update(
            ARCHIVE=str(ARCHIVE), CHECKSUMS=str(self.checksums), REPOSITORY=REPOSITORY, TAG=TAG
        )
        self.mock("curl", """
url=${!#}
printf '%s\\n' "$url" >> "$CALLS"
while [[ $1 != --output ]]; do shift; done
out=$2
base="https://github.com/$REPOSITORY/releases"
case "$url" in
  "$base/latest")
    if [[ ${MISSING_RELEASE:-} ]]; then printf '%s' "$base"; else printf '%s/tag/%s' "$base" "$TAG"; fi
    ;;
  "$base/download/$TAG/SHA256SUMS") cp "$CHECKSUMS" "$out" ;;
  "$base/download/$TAG/${ARCHIVE##*/}")
    if [[ ${BROKEN_DOWNLOAD:-} ]]; then exit 22; fi
    cp "$ARCHIVE" "$out"
    ;;
  *) exit 99 ;;
esac
""")

    def run_installer(self):
        result = self.command("/bin/bash", input=INSTALLER.read_text())
        self.assertEqual(list(self.root.glob("wald-install.*")), [])
        self.assertEqual(list(self.destination.parent.glob(".wald.*")), [])
        return result

    def preserve_installation(self, message):
        self.destination.parent.mkdir(parents=True)
        self.destination.write_text("existing wald")
        self.assert_failure(self.run_installer(), message)
        self.assertEqual(self.destination.read_text(), "existing wald")

    def test_install_and_upgrade(self):
        with tarfile.open(ARCHIVE) as archive:
            self.assertEqual(set(archive.getnames()), {"wald", "LICENSE"})
            self.assertTrue(archive.getmember("wald").mode & 0o111)

        result = self.run_installer()
        self.assert_success(result)
        self.assertIn(f"Installed Wald {VERSION}", result.stdout)
        self.assertIn("to PATH", result.stdout)
        base = f"https://github.com/{REPOSITORY}/releases"
        self.assertEqual(self.calls.read_text().splitlines(), [
            f"{base}/latest", f"{base}/download/{TAG}/SHA256SUMS", f"{base}/download/{TAG}/{ARCHIVE.name}",
        ])
        self.destination.write_text("previous version")
        self.assert_success(self.run_installer())
        self.assertEqual(self.command(self.destination, "--version").stdout.strip(), VERSION)

    def test_install_to_custom_directory(self):
        self.destination = self.root / "custom bin/wald"
        self.env["WALD_INSTALL_DIR"] = str(self.destination.parent)
        self.env["PATH"] = f"{self.destination.parent}:{self.env['PATH']}"
        result = self.run_installer()
        self.assert_success(result)
        self.assertIn(str(self.destination), result.stdout)
        self.assertNotIn("to PATH", result.stdout)
        self.assertTrue(os.access(self.destination, os.X_OK))

    def test_missing_release_preserves_installation(self):
        self.env["MISSING_RELEASE"] = "1"
        self.preserve_installation("Could not find a stable published release")

    def test_unknown_platform_preserves_installation(self):
        self.mock("uname", "printf 'unsupported\\n'")
        self.preserve_installation("Supported platforms")
        self.assertFalse(self.calls.exists())

    def test_failed_download_preserves_installation(self):
        self.env["BROKEN_DOWNLOAD"] = "1"
        self.preserve_installation("Could not download wald-")

    def test_wrong_checksum_preserves_installation(self):
        self.checksums.write_text(f"{'0' * 64}  {ARCHIVE.name}\n")
        self.preserve_installation("SHA-256 checksum mismatch")

    def test_wrong_binary_version_preserves_installation(self):
        self.env["TAG"] = "v0.0.0"
        self.preserve_installation("Expected Wald 0.0.0")

    def test_truncated_script_does_not_start_installation(self):
        truncated = INSTALLER.read_text().rsplit(")", 1)[0]
        self.assert_failure(self.command("/bin/bash", input=truncated), "syntax error")
        self.assertFalse(self.calls.exists())
        self.assertFalse(self.destination.exists())


class PackagingTest(ReleaseTest):
    def setUp(self):
        super().setUp()
        self.assets = self.root / "assets"
        self.assets.mkdir()
        for name in ARCHIVES:
            (self.assets / name).write_text(name)
        self.mock("gh", """
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  api) printf '%s\\n' "${EXISTING_TAG:-}" ;;
  release) ;;
  *) exit 99 ;;
esac
""")

    def release(self, *args):
        return self.command("/bin/bash", RELEASE, *args)

    def test_complete_set_creates_a_draft_for_the_existing_tag(self):
        self.assert_success(self.release("prepare", self.assets))
        checksums = (self.assets / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(checksums, [
            f"{hashlib.sha256(name.encode()).hexdigest()}  {name}" for name in ARCHIVES
        ])
        self.assert_success(self.release("draft", self.assets, REPOSITORY, TAG))
        self.assertEqual(self.calls.read_text().splitlines()[1].split(), [
            "release", "create", TAG, "--repo", REPOSITORY, "--verify-tag", "--draft",
            "--generate-notes", *ARCHIVES, "SHA256SUMS",
        ])

    def test_incomplete_set_stops_before_checksumming(self):
        (self.assets / ARCHIVES[0]).unlink()
        self.assert_failure(self.release("prepare", self.assets), "Expected exactly four platform archives")
        self.assertFalse((self.assets / "SHA256SUMS").exists())

    def test_corrupted_asset_stops_before_contacting_github(self):
        self.assert_success(self.release("prepare", self.assets))
        (self.assets / ARCHIVES[0]).write_text("corrupted archive")
        self.assert_failure(self.release("draft", self.assets, REPOSITORY, TAG), "checksum did NOT match")
        self.assertFalse(self.calls.exists())

    def test_existing_release_is_preserved(self):
        self.assert_success(self.release("prepare", self.assets))
        self.env["EXISTING_TAG"] = TAG
        self.assert_failure(self.release("draft", self.assets, REPOSITORY, TAG), "already exists")
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)

    def test_tag_must_match_binary_and_package_version(self):
        self.env["PATH"] = os.environ["PATH"]
        binary = self.mock("wald", f"printf '%s\\n' '{VERSION}'")
        self.assert_success(self.release("check-version", binary, TAG))
        self.assert_failure(self.release("check-version", binary, "v99.0.0"), "does not match CLI version")
        self.assert_failure(self.release("check-version", binary, f"{TAG}-rc.1"), "Expected a stable version tag")
        self.mock("wald", "printf '99.0.0\\n'")
        self.assert_failure(self.release("check-version", binary, TAG), "Binary version 99.0.0")


if __name__ == "__main__":
    ARCHIVE = Path(sys.argv.pop(1)).resolve()
    unittest.main()
