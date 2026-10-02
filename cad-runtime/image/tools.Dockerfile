# Build tools for the CAD runtime image: the arm64 cross compiler for the kernel and the test guest, and the
# filesystem tools that turn the rootfs into a read-only erofs image and the job disk template.
ARG TOOLS_BASE
FROM ${TOOLS_BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
      make bc flex bison libssl-dev libelf-dev xz-utils cpio erofs-utils e2fsprogs python3 \
 && rm -rf /var/lib/apt/lists/*
