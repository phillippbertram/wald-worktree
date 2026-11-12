#!/usr/bin/env python3
"""Regression tests for the terminal demo recorder."""

import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


class RecorderTest(unittest.TestCase):
    def test_guided_demo_with_fragmented_terminal_output(self):
        recorder = runpy.run_path(str(Path(__file__).with_name("record-demos.py")))
        read = os.read

        def read_fragment(fd, count):
            return read(fd, min(count, 64) if os.isatty(fd) else count)

        with tempfile.TemporaryDirectory(dir="/tmp", prefix="w-") as directory:
            fixture = recorder["Fixture"](Path(directory).resolve())
            with patch.object(os, "read", read_fragment):
                recorder["guided"](fixture, recorder["WIDTHS"]["compact"])


if __name__ == "__main__":
    unittest.main()
