# Build tools for the CAD runtime images: the arm64 cross compiler and the native compiler for the kernels and the
# test guest, gpgv for the kernel signature, and the filesystem tools that turn a rootfs into a read-only erofs image
# and the job disk template. Packages come from one Debian snapshot (snapshot.sources), so the toolchain that
# compiles the kernels is the same on every build.
ARG TOOLS_BASE
FROM ${TOOLS_BASE}
ARG DEBIAN_SNAPSHOT
COPY --chmod=0644 snapshot.sources /tmp/snapshot.sources
RUN sed "s/@SNAPSHOT@/${DEBIAN_SNAPSHOT}/" /tmp/snapshot.sources > /etc/apt/sources.list.d/debian.sources \
 && rm /tmp/snapshot.sources \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends gcc libc6-dev gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
      make bc flex bison libssl-dev libelf-dev xz-utils cpio erofs-utils e2fsprogs python3 gpg gpgv \
 && rm -rf /var/lib/apt/lists/*
