#!/usr/bin/env bash
# Runs every restriction test against the real VM and writes one log with the host, helper, and runtime identity.
#   HELPER=... RUNTIME=... cad-host/restriction-tests/run-all.sh [log]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${HELPER:?}" "${RUNTIME:?}"
log="${1:-$here/../out/restriction-tests.log}"
mkdir -p "$(dirname "$log")"
{
  echo "restriction tests, $(date -u +%FT%TZ)"
  echo "host: $(sysctl -n machdep.cpu.brand_string), $(($(sysctl -n hw.memsize) >> 30)) GiB, macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "helper: sha256 $(shasum -a 256 "$HELPER" | cut -d' ' -f1)"
  codesign -dv --entitlements - "$HELPER" 2>&1 | grep -E 'Signature=|flags=|com.apple.security' | sed 's/^/  /'
  echo "runtime pins compiled into the helper: sha256 $("$HELPER" pins | shasum -a 256 | cut -d' ' -f1)"
  pass=0 fail=0
  for t in "$here"/[0-9][0-9]-*.sh; do
    echo
    echo "== $(basename "$t" .sh)"
    started=$(date +%s)
    if bash "$t"; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
    echo "   ($(($(date +%s) - started)) s)"
  done
  echo
  echo "summary: $pass passed, $fail failed"
} 2>&1 | tee "$log"
grep -q 'summary: [0-9]* passed, 0 failed' "$log"
