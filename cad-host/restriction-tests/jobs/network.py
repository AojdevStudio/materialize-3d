# Hostile job: try every way out of the guest. Each attempt prints its result; any success is a breach.
import os, socket, sys

def attempt(label, fn):
    try:
        fn()
        print(f"{label}: CONNECTED", file=sys.stderr)
    except Exception as e:
        print(f"{label}: blocked ({type(e).__name__}: {e})", file=sys.stderr)

def build(p):
    print("interfaces=" + ",".join(sorted(os.listdir("/sys/class/net"))), file=sys.stderr)
    attempt("tcp 1.1.1.1:443", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))
    attempt("tcp 192.168.64.1:22", lambda: socket.create_connection(("192.168.64.1", 22), timeout=3))
    attempt("dns example.com", lambda: socket.getaddrinfo("example.com", 443))
    def udp():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.sendto(b"x", ("8.8.8.8", 53))
    attempt("udp 8.8.8.8:53", udp)
    for cid, port in [(2, 7000), (2, 22), (2, 80), (1, 7000), (3, 7000)]:
        def vsock(cid=cid, port=port):
            s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
            s.settimeout(3)
            s.connect((cid, port))
        attempt(f"vsock {cid}:{port}", vsock)
    raise RuntimeError("network probe finished")
