# Root filesystem of every CAD guest, built per architecture from one pinned lock file. The guest boots it as a
# read-only erofs image; nothing in it ever runs on the Mac host.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}
ARG TARGETARCH
COPY lock/requirements-${TARGETARCH}.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary :all: --no-deps -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt
# OCP links libGL and libX11 but never renders: the glvnd stub without a Mesa driver is enough.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libx11-6 libexpat1 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 job && useradd -u 1000 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin job
COPY guest/materialize.py guest/m3d_text.py /usr/local/lib/python3.13/site-packages/
COPY guest/init guest/agent.py guest/runner.py guest/inspector.py /opt/m3d/
# The root is read-only and its timestamps are clamped, so bytecode is compiled here with hash-based invalidation
# that never checks mtimes. The import check fails the build if a wheel needs a system library the image lacks.
RUN chmod 0755 /opt/m3d/init && chmod 0644 /opt/m3d/*.py && mkdir -m 0755 /job \
 && python -m compileall -q -j0 --invalidation-mode unchecked-hash /usr/local/lib/python3.13 /opt/m3d \
 && python -I -c "import build123d, materialize, m3d_text, OCP.BRepMesh, OCP.STEPControl" \
 && rm -rf /usr/share/doc /usr/share/man /usr/share/locale /var/cache/* /root/.cache
