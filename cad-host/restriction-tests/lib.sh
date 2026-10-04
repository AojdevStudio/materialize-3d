# Shared helpers for the restriction tests. Each test sources this, runs the signed helper against the real VM,
# checks host-side facts, and ends with `finish`, which prints PASS or FAIL and exits 0 or 1.
#   HELPER   signed materialize-cad-host binary
#   RUNTIME  runtime directory (Image, rootfs.img, job.img, hostile-initramfs.cpio), as cad-runtime/build.sh writes it
#   OUT_ROOT where each test writes its outputs
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${HELPER:?set HELPER to the signed helper}" "${RUNTIME:?set RUNTIME to the runtime directory}"
: "${OUT_ROOT:=$here/../out/restriction-tests}"
JOBS="$here/jobs"
test_name="$(basename "$0" .sh)"
failures=()

# Fresh output directory for one helper run.
case_dir() {
  local dir="$OUT_ROOT/$test_name/$1"
  rm -rf "$dir" && mkdir -p "$dir" && printf '%s\n' "$dir"
}

# Runs the helper; records its stderr, exit code, and wall time next to result.json. The helper requires an empty
# --out, so its stderr goes beside the directory during the run and moves in afterwards.
run_helper() {
  local out="${*: -1}" started ended code
  started=$(date +%s)
  "$HELPER" "$@" --runtime "$RUNTIME" >/dev/null 2>"$out.stderr"
  code=$?
  ended=$(date +%s)
  mv "$out.stderr" "$out/helper.stderr"
  printf '%s\n' "$code" > "$out/exit"
  printf '%s\n' "$((ended - started))" > "$out/wall_s"
}

field() { jq -r "$2" "$1/result.json"; }
diag() { cat "$1/diagnostics-generate.txt" 2>/dev/null; }

# check DESCRIPTION COMMAND...: records a failure unless the command succeeds.
check() {
  local what="$1"; shift
  if "$@"; then
    echo "  ok    $what"
  else
    echo "  FAIL  $what"
    failures+=("$what")
  fi
}

no_vm_running() { ! pgrep -q -f com.apple.Virtualization.VirtualMachine; }

# The runtime files still match the helper's compiled-in pins after the run (nothing the guest did reached them).
runtime_unchanged() { "$HELPER" verify --runtime "$RUNTIME" >/dev/null 2>&1; }

finish() {
  if ((${#failures[@]} == 0)); then
    echo "PASS $test_name"
    exit 0
  fi
  echo "FAIL $test_name: ${failures[*]}"
  exit 1
}
