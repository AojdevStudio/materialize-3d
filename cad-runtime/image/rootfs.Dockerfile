# Root filesystem of every CAD guest, built per architecture from one pinned lock file. The guest boots it as a
# read-only erofs image; nothing in it ever runs on the Mac host.
# Reproducible: the base image is pinned by digest, wheels by hash, Debian packages by one snapshot timestamp, file
# modes are set here rather than taken from the checkout, bytecode is compiled in one process with a fixed hash
# seed, logs are deleted, and build.sh clamps every timestamp when it packs the erofs image. reproduce.sh proves it.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}
ARG TARGETARCH
ARG DEBIAN_SNAPSHOT
# useradd stamps /etc/shadow's last-change day from this instead of today's date.
ARG SOURCE_DATE_EPOCH
COPY --chmod=0644 lock/requirements-${TARGETARCH}.txt /tmp/requirements.txt
# The wheels come from build.sh's hash-checked cache (the `wheels` build context), never from the network here.
RUN --mount=type=bind,from=wheels,target=/wheels \
    PYTHONDONTWRITEBYTECODE=1 pip install --no-cache-dir --no-compile --no-index --find-links /wheels \
      --require-hashes --only-binary :all: --no-deps -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt
# OCP links libGL and libX11 but never renders: the glvnd stub without a Mesa driver is enough.
COPY --chmod=0644 image/snapshot.sources /tmp/snapshot.sources
RUN sed "s/@SNAPSHOT@/${DEBIAN_SNAPSHOT}/" /tmp/snapshot.sources > /etc/apt/sources.list.d/debian.sources \
 && rm /tmp/snapshot.sources \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends libgl1 libx11-6 libexpat1 \
 && rm -rf /var/lib/apt/lists/* \
 && find /var/log -type f -delete
RUN groupadd -g 1000 job && useradd -u 1000 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin job
COPY guest/materialize.py guest/m3d_text.py /usr/local/lib/python3.13/site-packages/
COPY guest/init guest/agent.py guest/runner.py guest/inspector.py /opt/m3d/
# COPY keeps the checkout's file modes, which follow the umask of whoever cloned it, so every mode is set here.
# (COPY --chmod would also apply the file mode to the /opt/m3d directory it creates.)
# The root is read-only and its timestamps are clamped, so bytecode is compiled here with hash-based invalidation
# that never checks mtimes. One process (no -j) with a fixed hash seed writes the same marshal output on every
# build; parallel workers and randomized string hashing do not. -f replaces any bytecode an import wrote earlier.
# The import check fails the build if a wheel needs a system library the image lacks; -B keeps it from writing.
RUN chmod 0755 /opt/m3d/init \
 && chmod 0644 /opt/m3d/*.py /usr/local/lib/python3.13/site-packages/materialize.py \
      /usr/local/lib/python3.13/site-packages/m3d_text.py \
 && mkdir -m 0755 /job \
 && PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 \
      python -m compileall -q -f --invalidation-mode unchecked-hash /usr/local/lib/python3.13 /opt/m3d \
 && python -I -B -c "import build123d, materialize, m3d_text, OCP.BRepMesh, OCP.STEPControl" \
 && rm -rf /usr/share/doc /usr/share/man /usr/share/locale /var/cache/* /root/.cache
