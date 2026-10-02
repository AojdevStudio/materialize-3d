# Hostile job: ignore every signal it can and spin forever. Only a stop from outside ends it.
import signal

def build(p):
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1):
        signal.signal(sig, signal.SIG_IGN)
    while True:
        pass
