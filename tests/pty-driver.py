"""Run one command with stdin and stdout on a genuine pseudo-terminal.

Used by tests/pty.ts. The child's stdin and stdout are the pty slave (it is
the child's controlling terminal, in its own session); its stderr is a plain
pipe so a test can tell prompts on stderr from the report on stdout. Standard
library only.

Protocol: argv[1] is a JSON spec {"argv": [...], "cwd": str, "env": {...},
"rows": int, "cols": int}. Events go to our stdout as JSON lines:
  {"t": "out", "d": text}   bytes the child wrote to the terminal
  {"t": "err", "d": text}   bytes the child wrote to its stderr pipe
  {"t": "exit", "code": int|null, "signal": int|null}
Commands arrive on our stdin as JSON lines: {"send": text} writes to the
terminal (keystrokes), {"kill": true} kills the child's process group. End of
our stdin also kills the child.
"""

import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios

spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(
    slave,
    termios.TIOCSWINSZ,
    struct.pack("HHHH", spec.get("rows", 40), spec.get("cols", 200), 0, 0),
)


def become_controlling_terminal():
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


child = subprocess.Popen(
    spec["argv"],
    cwd=spec["cwd"],
    env=spec["env"],
    stdin=slave,
    stdout=slave,
    stderr=subprocess.PIPE,
    start_new_session=True,
    preexec_fn=become_controlling_terminal,
)
os.close(slave)  # Only the child holds the slave, so its exit ends the master.

emit_out = sys.stdout


def emit(event):
    emit_out.write(json.dumps(event) + "\n")
    emit_out.flush()


def kill_child():
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        try:
            child.kill()
        except OSError:
            pass


selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, "out")
selector.register(child.stderr, selectors.EVENT_READ, "err")
selector.register(sys.stdin, selectors.EVENT_READ, "cmd")
pending = b""
open_streams = {"out", "err"}
stdin_open = True
try:
    while open_streams:
        for key, _ in selector.select():
            kind = key.data
            if kind == "cmd":
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    stdin_open = False
                    selector.unregister(sys.stdin)
                    kill_child()
                    continue
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line.strip():
                        continue
                    command = json.loads(line)
                    if "send" in command:
                        os.write(master, command["send"].encode())
                    if command.get("kill"):
                        kill_child()
                continue
            fd = master if kind == "out" else child.stderr.fileno()
            try:
                data = os.read(fd, 65536)
            except OSError:  # EIO: the slave side is closed (Linux)
                data = b""
            if not data:
                selector.unregister(key.fileobj)
                open_streams.discard(kind)
                continue
            emit({"t": kind, "d": data.decode("utf-8", "replace")})
finally:
    kill_child()
code = child.wait()
emit(
    {
        "t": "exit",
        "code": code if code >= 0 else None,
        "signal": -code if code < 0 else None,
    }
)
