#!/usr/bin/env bash
# Runs each TLC check and compares its verdict with the one recorded below.
#   check.sh            every check on the models as they describe the code
#   check.sh --mutants  every broken variant, each of which must fail its check
# Exit 0 when every verdict matches, 1 when one differs, 2 when TLC cannot run.
set -euo pipefail

TLC_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

# check | model | config | kind | property | expected verdict
CHECKS='
no-build-cut-off        UpdateRestart UpdateRestart            INVARIANT NoBuildCutOff           holds
gate-held-until-restart UpdateRestart UpdateRestart            INVARIANT GateHeldUntilRestart    holds
failed-update-reopens   UpdateRestart UpdateRestart            INVARIANT FailedUpdateReopens     holds
update-wakes            UpdateRestart UpdateRestartBuildsStop  PROPERTY  UpdateGoesAhead         holds
update-not-starved      UpdateRestart UpdateRestart            PROPERTY  UpdateGoesAhead         fails
'

# mutant | check it must fail
MUTANTS='
split-close    gate-held-until-restart
late-subscribe update-wakes
ungated-slice  no-build-cut-off
ungated-turn   no-build-cut-off
early-release  no-build-cut-off
guard-dropped  no-build-cut-off
guard-leaked   failed-update-reopens
'

jar=${TLA2TOOLS_JAR:-}
if [[ -z $jar || ! -f $jar ]]; then
  echo "TLC is not set up. Set TLA2TOOLS_JAR to tla2tools.jar from TLA+ v1.7.4 (sha256 $TLC_SHA256)." >&2
  exit 2
fi
# shasum ships with macOS. sha256sum ships with GNU coreutils.
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$jar"); else sum=$(shasum -a 256 "$jar"); fi
if [[ ${sum%% *} != "$TLC_SHA256" ]]; then
  echo "$jar is not tla2tools.jar v1.7.4 (sha256 $TLC_SHA256)." >&2
  exit 2
fi
command -v java >/dev/null || { echo "java 11 or newer is not on PATH." >&2; exit 2; }

models=$(cd "$(dirname "$0")/../models" && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/m3d-tlc.XXXXXX")
cp "$models"/*.tla "$models"/*.cfg "$out"/

# run <label> <model> <config> <kind> <property> <mutant>; prints holds or fails
run() {
  local label=$1 model=$2 config=$3 kind=$4 prop=$5 mutant=$6
  local cfg="$out/$label.cfg" status=0
  sed "s/Mutant = \"none\"/Mutant = \"$mutant\"/" "$out/$config.cfg" >"$cfg"
  printf '%s %s\n' "$kind" "$prop" >>"$cfg"
  (cd "$out" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -deadlock \
    -metadir "$out/states-$label" -config "$cfg" "$model.tla") >"$out/$label.out" 2>&1 || status=$?
  case $status in
    0) echo holds ;;
    12 | 13) echo fails ;;
    *) echo "TLC stopped with exit $status on $label. See $out/$label.out" >&2; exit 2 ;;
  esac
}

mismatch=0
if [[ ${1:-} == --mutants ]]; then
  while read -r mutant check; do
    [[ -z $mutant ]] && continue
    read -r _ model config kind prop _ < <(grep -E "^$check " <<<"$CHECKS")
    got=$(run "$mutant" "$model" "$config" "$kind" "$prop" "$mutant")
    [[ $got == fails ]] || mismatch=1
    printf '%-15s %-24s %-6s (must fail)\n' "$mutant" "$check" "$got"
  done <<<"$MUTANTS"
else
  while read -r check model config kind prop expected; do
    [[ -z $check ]] && continue
    got=$(run "$check" "$model" "$config" "$kind" "$prop" none)
    [[ $got == "$expected" ]] || mismatch=1
    printf '%-24s %-6s (recorded: %s)\n' "$check" "$got" "$expected"
  done <<<"$CHECKS"
fi
echo "TLC output: $out"
exit $mismatch
