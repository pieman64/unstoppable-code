"""Real slave-PTY peer; independent TCP control survives closing PTY stdio."""

import json
import os
import select
import signal
import socket
import tty


signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
signal.alarm(8)
tty.setraw(0)
control = socket.create_connection(
    ("127.0.0.1", int(os.environ["CANOPY_CLOSED_PIPE_CONTROL_PORT"])), timeout=3
)
received = 0
armed = False
reading = True
pending = b""
commands = b""


def send(event, **extra):
    control.sendall((json.dumps({"event": event, **extra}) + "\n").encode())


os.write(1, b"native-history\r\n")
send("ready")
while True:
    ready, _, _ = select.select([control, 0] if reading else [control], [], [])
    if 0 in ready:
        chunk = os.read(0, 4096)
        received += len(chunk)
        if armed:
            reading = False
            send("first-bytes", bytes=len(chunk))
        else:
            commands += chunk
            if b"execute-once\r" in commands:
                with open(os.environ["CANOPY_CLOSED_PIPE_COMMAND_LOG_PATH"], "ab") as log:
                    log.write(b"executed\n")
                commands = b""
                os.write(1, b"executed-once\r\n")
                send("executed")
    if control in ready:
        chunk = control.recv(4096)
        if not chunk:
            os._exit(126)
        pending += chunk
        while b"\n" in pending:
            op, pending = pending.split(b"\n", 1)
            if op == b"close":
                reading = False
                # All refer to the slave: closing fd0 alone leaves the PTY open.
                for fd in (0, 1, 2):
                    os.close(fd)
                send("closed")
            elif op == b"arm":
                armed = True
                send("armed")
            elif op == b"snapshot":
                send("snapshot", received=received)
            elif op == b"exit":
                os._exit(23)
