#!/usr/bin/env bash
# Measures the spike on this Mac: RUNS cold builds of the reference part through both guests (every guest is a
# fresh VM, so every boot is cold), the VM process's peak resident memory, and the runtime's sizes.
#   HELPER=... RUNTIME=... cad-host/spike/measure.sh [log]
set -euo pipefail
: "${HELPER:?}" "${RUNTIME:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${OUT:-$here/../out/measure}"
runs="${RUNS:-5}"
source="${SOURCE:-$here/cable-clip-fillet-first.py}"
log="${1:-$out/measurements.log}"
rm -rf "$out" && mkdir -p "$out"
{
  echo "measurements, $(date -u +%FT%TZ)"
  echo "host: $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores, $(($(sysctl -n hw.memsize) >> 30)) GiB, macOS $(sw_vers -productVersion)"
  echo "part: $(basename "$source"), guests: 2 vCPU and 2048 MiB each"
  printf '%-4s %8s %8s %8s %8s %8s %8s %8s %9s %9s %9s\n' run verify gen_boot gen_job gen_total ins_boot ins_job ins_total wall_ms vm_rss_mib helper_mib
  for i in $(seq 1 "$runs"); do
    d="$out/run-$i" && mkdir -p "$d"
    ( set +eo pipefail  # sampling must survive moments when no VM process exists yet
      peak=0
      while true; do
        rss=$(pgrep -f com.apple.Virtualization.VirtualMachine | xargs -r ps -o rss= -p 2>/dev/null | awk '{s+=$1} END {print s+0}')
        ((rss > peak)) && peak=$rss && echo "$peak" > "$d/vm-peak-rss-kib"
        sleep 0.05
      done ) &
    sampler=$!
    /usr/bin/time -l "$HELPER" build --runtime "$RUNTIME" --source "$source" --params "$here/cable-clip.params.json" --out "$d/helper" > /dev/null 2> "$d/stderr" || true
    kill "$sampler" 2>/dev/null || true
    wait "$sampler" 2>/dev/null || true
    r="$d/helper/result.json"  # the helper needs an empty --out; the sampler and time write beside it
    test "$(jq -r .outcome "$r")" = accepted || { echo "run $i: $(jq -r .error "$r")"; exit 1; }
    test "$(jq -r '.bodies[0].mesh.closed_manifold' "$r")" = true || { echo "run $i: mesh not closed"; exit 1; }
    printf '%-4s %8s %8s %8s %8s %8s %8s %8s %9s %9s %9s\n' "$i" \
      "$(sed -n 's/runtime verified in \([0-9]*\) ms/\1/p' "$d/stderr")" \
      "$(jq .guests[0].timings.boot_ms "$r")" "$(jq .guests[0].timings.job_ms "$r")" "$(jq .guests[0].timings.total_ms "$r")" \
      "$(jq .guests[1].timings.boot_ms "$r")" "$(jq .guests[1].timings.job_ms "$r")" "$(jq .guests[1].timings.total_ms "$r")" \
      "$(awk '/ real /{printf "%d", $1 * 1000}' "$d/stderr")" \
      "$(($(cat "$d/vm-peak-rss-kib" 2>/dev/null || echo 0) >> 10))" \
      "$(($(awk '/maximum resident set size/{print $1}' "$d/stderr") >> 20))"
  done
  echo
  echo "guest job memory peak (cgroup memory.peak, MiB): generate $(($(jq .guests[0].stats.memory_peak "$out/run-1/helper/result.json") >> 20)), inspect $(($(jq .guests[1].stats.memory_peak "$out/run-1/helper/result.json") >> 20))"
  echo "guest start (framework start call to running, ms): $(jq -s 'map(.guests[].timings.start_ms) | "min \(min) max \(max)"' -r "$out"/run-*/helper/result.json)"
  echo
  echo "sizes (bytes):"
  for f in Image rootfs.img job.img; do printf '  %-12s %12s on disk, %12s allocated\n' "$f" "$(stat -f %z "$RUNTIME/$f")" "$(($(stat -f %b "$RUNTIME/$f") * 512))"; done
  echo "  rootfs installed (unpacked tree): $(jq .rootfs_installed_bytes "$RUNTIME/pins.json")"
  for f in rootfs.img job.img; do
    compression_tool -encode -a lzfse -i "$RUNTIME/$f" -o "$out/$f.lzfse"
    printf '  %-12s %12s lzfse (what a compressed DMG would carry)\n' "$f" "$(stat -f %z "$out/$f.lzfse")"
    rm -f "$out/$f.lzfse"
  done
} 2>&1 | tee "$log"
