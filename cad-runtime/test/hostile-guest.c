/*
 * Restriction-test guest: a stand-in for a fully compromised inspection guest. Booted as /init from an initramfs
 * by the host's restriction tests, it answers the host's job with one hostile response chosen by the kernel
 * command line (m3d.case=<name>), then reports success and powers off. The host must reject every case.
 * Frames match the agent: 4-byte tag, little-endian u32 length, payload.
 */
#include <linux/vm_sockets.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <unistd.h>

static int conn = -1;

static void put(const void *p, size_t n) {
    const char *c = p;
    while (n > 0) {
        ssize_t w = write(conn, c, n);
        if (w <= 0) return;
        c += w;
        n -= (size_t)w;
    }
}

static int get(void *p, size_t n) {
    char *c = p;
    while (n > 0) {
        ssize_t r = read(conn, c, n);
        if (r <= 0) return -1;
        c += r;
        n -= (size_t)r;
    }
    return 0;
}

static void header(const char *tag, uint32_t len) {
    put(tag, 4);
    put(&len, 4);
}

static void frame(const char *tag, const void *p, uint32_t len) {
    header(tag, len);
    put(p, len);
}

/* Reads one host frame and returns whether its payload mentions an inspect job. */
static int read_host_frame(void) {
    char hdr[8];
    uint32_t len;
    if (get(hdr, 8) != 0) return -1;
    memcpy(&len, hdr + 4, 4);
    char *buf = malloc(len + 1);
    if (buf == NULL || get(buf, len) != 0) return -1;
    buf[len] = 0;
    int inspect = memcmp(hdr, "JOBS", 4) == 0 && strstr(buf, "\"inspect\"") != NULL;
    free(buf);
    return inspect;
}

/* A closed tetrahedron, then the caller corrupts one field. */
static size_t mesh(unsigned char *out, double *v, uint32_t nv, uint32_t *t, uint32_t nt, uint32_t bodies) {
    size_t n = 0;
    memcpy(out + n, "M3DMESH1", 8); n += 8;
    memcpy(out + n, &bodies, 4); n += 4;
    memcpy(out + n, &nv, 4); n += 4;
    memcpy(out + n, &nt, 4); n += 4;
    memcpy(out + n, v, nv * 24); n += nv * 24;
    memcpy(out + n, t, nt * 12); n += nt * 12;
    return n;
}

static void power_off(void) {
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}

int main(void) {
    char cmdline[1024] = {0}, which[64] = "none";
    mount("proc", "/proc", "proc", 0, NULL);
    FILE *f = fopen("/proc/cmdline", "r");
    if (f != NULL) {
        if (fgets(cmdline, sizeof cmdline, f) == NULL) cmdline[0] = 0;
        fclose(f);
    }
    char *at = strstr(cmdline, "m3d.case=");
    if (at != NULL) sscanf(at + 9, "%63[a-z0-9-]", which);

    conn = socket(AF_VSOCK, SOCK_STREAM, 0);
    struct sockaddr_vm addr = {.svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = 7000};
    if (conn < 0 || connect(conn, (struct sockaddr *)&addr, sizeof addr) != 0) power_off();
    if (read_host_frame() == 1) read_host_frame();

    double v[12] = {0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10};
    uint32_t t[12] = {0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3};
    static unsigned char buf[1 << 16];
    size_t n = 0;
    const char *done = "{\"ok\":true,\"error\":null}";

    if (strcmp(which, "valid") == 0) {
        n = mesh(buf, v, 4, t, 4, 1);
        frame("MESH", buf, n);
    } else if (strcmp(which, "nan") == 0) {
        v[4] = NAN;
        frame("MESH", buf, mesh(buf, v, 4, t, 4, 1));
    } else if (strcmp(which, "inf") == 0) {
        v[5] = INFINITY;
        frame("MESH", buf, mesh(buf, v, 4, t, 4, 1));
    } else if (strcmp(which, "far") == 0) {
        v[3] = 1e300;
        frame("MESH", buf, mesh(buf, v, 4, t, 4, 1));
    } else if (strcmp(which, "index") == 0) {
        t[11] = 7;
        frame("MESH", buf, mesh(buf, v, 4, t, 4, 1));
    } else if (strcmp(which, "huge-count") == 0) {
        n = mesh(buf, v, 4, t, 4, 1);
        uint32_t huge = 0x7fffffff;
        memcpy(buf + 12, &huge, 4); /* claims 2^31 vertices in a 200-byte payload */
        frame("MESH", buf, n);
    } else if (strcmp(which, "zero-bodies") == 0) {
        frame("MESH", buf, mesh(buf, v, 4, t, 4, 0) - (4 * 24 + 4 * 12 + 8));
    } else if (strcmp(which, "trailing") == 0) {
        n = mesh(buf, v, 4, t, 4, 1);
        memcpy(buf + n, "EXTRA", 5);
        frame("MESH", buf, n + 5);
    } else if (strcmp(which, "big-frame") == 0) {
        header("MESH", 0xffffffffu); /* 4 GiB announced; the host must refuse before reading or allocating */
        put(buf, sizeof buf);
    } else if (strcmp(which, "bad-tag") == 0) {
        frame("../x", "/etc/passwd", 11);
    } else if (strcmp(which, "duplicate") == 0) {
        n = mesh(buf, v, 4, t, 4, 1);
        frame("MESH", buf, n);
        frame("MESH", buf, n);
    } else if (strcmp(which, "wrong-role") == 0) {
        frame("MANI", "{\"bodies\":[]}", 13);
    } else if (strcmp(which, "silent") == 0) {
        for (;;) pause(); /* never answers: only the host deadline ends this guest */
    }
    frame("DONE", done, (uint32_t)strlen(done));
    close(conn);
    power_off();
    return 0;
}
