# Shared helpers for the restriction tests. Each test sources this, runs the signed helper against the real VM,
# checks host-side facts, and ends with `finish`, which prints PASS or FAIL and exits 0 or 1.
#   HELPER   signed materialize-cad-host binary
#   RUNTIME  runtime directory (Image, rootfs.img, job.img, hostile-initramfs.cpio, pins.json)
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

# Runs the helper; records its exit code and wall time next to result.json.
run_helper() {
  local out="${*: -1}" started ended code
  started=$(date +%s)
  "$HELPER" "$@" --runtime "$RUNTIME" >/dev/null 2>"$out/helper.stderr"
  code=$?
  ended=$(date +%s)
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

# The runtime files still match their pins after the run (nothing the guest did reached them).
runtime_unchanged() {
  local name want got
  for name in Image rootfs.img job.img; do
    want="$(jq -r --arg n "$name" '.files[$n].sha256' "$RUNTIME/pins.json")"
    got="$(shasum -a 256 "$RUNTIME/$name" | cut -d' ' -f1)"
    [[ "$want" == "$got" ]] || return 1
  done
}

finish() {
  if ((${#failures[@]} == 0)); then
    echo "PASS $test_name"
    exit 0
  fi
  echo "FAIL $test_name: ${failures[*]}"
  exit 1
}
