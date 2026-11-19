"""Run a small CLI test with a terminal on stdin/stdout and no simulated keystrokes."""
import errno
import os
import pty
import subprocess
import sys
import threading

master, slave = pty.openpty()
with subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave) as child:
    os.close(slave)

    def forward_stdout():
        while True:
            try:
                data = os.read(master, 8192)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    reader = threading.Thread(target=forward_stdout, daemon=True)
    reader.start()
    try:
        status = child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        sys.exit("wald waited for terminal input")
    reader.join(timeout=2)
    os.close(master)
    sys.exit(status)
