#!/usr/bin/env bash
# Verifies the installed, signed release app on this Mac without the e2e
# harness, unattended: no Terminal window, no person, no secret in argv.
#
# Keychain unlock state belongs to a security (audit) session, and the app runs
# in the logged-in user's desktop (Aqua) session. So the verification body does
# not run in the calling shell: it runs as a transient per-user LaunchAgent that
# this front half bootstraps into gui/<uid>. The job's process starts inside the
# desktop session, so its `security unlock-keychain` applies to the same session
# the app reads from. The front half only waits for the job, streams its log,
# boots it out, and exits with its status, which behaves the same whether the
# caller is an SSH shell, an agent, or a terminal already in that session.
#
# Isolation is unchanged: the app runs with a throwaway HOME, so its data folder
# and its keychain search list (the Security framework reads the list from HOME)
# point at throwaway files. The real user's keychains and preferences are never
# changed. Never prints credentials.
set -euo pipefail

LABEL_PREFIX=com.aojdevstudio.m3d-release-verify
JOB_TIMEOUT=900   # hard cap on the whole verification body
START_TIMEOUT=60  # how long launchd gets to start the job at all

usage() {
  cat <<'EOF'
usage: verify-installed-macos.sh <path-to-release.dmg> <checkout-with-docs/acceptance-and-schema3-fixture>

Installs the signed DMG into /Applications and verifies it end to end: Gatekeeper,
the staple, the signature, the schema 3 migration, MCP off by
default, the MCP endpoint's 401 without a valid token, the app's own keychain round
trip, and a sign built over MCP with a seeded token that stays pending: the endpoint
must refuse to approve, because approval stays with a person in the app. Each check
fails the run. Also records the bundle inventory for inspection. Runs unattended
and needs no input. The installed release app remains in /Applications afterward.

The user must be logged in at the console: the body runs as a LaunchAgent in that
desktop session, because that is the session whose keychain the app reads.
EOF
}

die() { printf 'verify: %s\n' "$*" >&2; exit 1; }

abspath() {
  if [[ -d "$1" ]]; then (cd "$1" && pwd -P); else
    local dir
    dir="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || die "no such path: $1"
    printf '%s/%s\n' "$dir" "$(basename "$1")"
  fi
}

# ---------------------------------------------------------------------------
# front half: bootstrap the job into the desktop session and wait for it
# ---------------------------------------------------------------------------
FRONT_UID=""
FRONT_LABEL=""
TAIL_PID=""
BOOTSTRAPPED=0

stop_tail() {
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$TAIL_PID" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
    TAIL_PID=""
  fi
}

front_cleanup() {
  stop_tail
  if [[ "$BOOTSTRAPPED" == 1 ]]; then
    launchctl bootout "gui/$FRONT_UID/$FRONT_LABEL" >/dev/null 2>&1 || true
    BOOTSTRAPPED=0
  fi
}

# launchctl print is the only way to tell "still running" from "exited without
# writing a result", so the wait never turns into an unbounded poll.
job_field() { # <uid> <label> <field name>
  launchctl print "gui/$1/$2" 2>/dev/null | sed -n "s/^[[:space:]]*$3 = //p" | head -1
}

run_front() {
  [[ $# -eq 2 ]] || { usage >&2; exit 2; }
  [[ "$(uname -s)" == Darwin ]] || die "this runs on macOS only"

  local dmg src uid runid run label plist script joblog status_file started_file
  local state status start now
  dmg="$(abspath "$1")"
  src="$(abspath "$2")"
  [[ -f "$dmg" ]] || die "no DMG at $1"
  [[ -f "$src/src-tauri/tests/fixtures/db/main-schema-v3.sql" ]] || die "no schema 3 fixture under $2"
  [[ -f "$src/docs/acceptance/p2s-test-sign.json" ]] || die "no docs/acceptance/p2s-test-sign.json under $2"

  uid="$(id -u)"
  # gui/<uid> exists only while the user is logged in at the console. Without it
  # there is no session to unlock a keychain in, so say so and stop.
  launchctl print "gui/$uid" >/dev/null 2>&1 || die \
    "no desktop session for uid $uid. Log in at the console (or turn on auto-login) and run again: the app's keychain cannot be unlocked from a session that has no desktop."

  runid="$(date +%Y%m%dT%H%M%S)"
  run="$HOME/m3d-verify/release-verify-$runid"
  [[ -e "$run" ]] && die "$run already exists"
  mkdir -p "$run/evidence"
  chmod 700 "$run"
  label="$LABEL_PREFIX.$runid"
  plist="$run/$label.plist"
  script="$(abspath "${BASH_SOURCE[0]}")"
  joblog="$run/job.log"
  status_file="$run/job.status"
  started_file="$run/job.started"
  FRONT_UID="$uid"
  FRONT_LABEL="$label"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script</string>
    <string>--launchd-job</string>
    <string>$run</string>
    <string>$dmg</string>
    <string>$src</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$joblog</string>
  <key>StandardErrorPath</key><string>$joblog</string>
  <key>WorkingDirectory</key><string>$run</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null || die "the job plist is not valid (an XML character in a path?): $plist"

  : > "$joblog"
  trap front_cleanup EXIT
  trap 'exit 130' INT TERM
  launchctl bootstrap "gui/$uid" "$plist" \
    || die "launchctl bootstrap gui/$uid failed for $plist"
  BOOTSTRAPPED=1
  printf 'verify: job %s is running in gui/%s\n' "$label" "$uid"
  tail -n +1 -F "$joblog" 2>/dev/null &
  TAIL_PID=$!

  start="$(date +%s)"
  while :; do
    if [[ -f "$status_file" ]]; then break; fi
    state="$(job_field "$uid" "$label" state || true)"
    now="$(date +%s)"
    if [[ -z "$state" ]]; then
      sleep 1
      if [[ -f "$status_file" ]]; then break; fi
      die "the job left gui/$uid without a result; log: $joblog"
    fi
    if [[ "$state" != running ]] && { [[ -f "$started_file" ]] || [[ $((now - start)) -ge $START_TIMEOUT ]]; }; then
      sleep 2
      if [[ -f "$status_file" ]]; then break; fi
      die "the job is '$state' and wrote no result (launchd last exit code $(job_field "$uid" "$label" 'last exit code' || true)); log: $joblog"
    fi
    if [[ $((now - start)) -ge $JOB_TIMEOUT ]]; then
      die "the job did not finish within ${JOB_TIMEOUT}s; log: $joblog"
    fi
    sleep 1
  done

  status="$(cat "$status_file" 2>/dev/null || true)"
  case "$status" in ''|*[!0-9]*) status=1 ;; esac
  sleep 1   # let the tail drain the job's last lines
  front_cleanup
  trap - EXIT
  printf 'verify: job finished with status %s\n' "$status"
  printf 'verify: log %s\n' "$joblog"
  printf 'verify: evidence %s/evidence\n' "$run"
  exit "$status"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --launchd-job) shift ;;      # fall through to the job body
  *) run_front "$@" ;;         # never returns
esac

# ---------------------------------------------------------------------------
# the job: everything below runs inside the user's desktop session
# ---------------------------------------------------------------------------
RUN="${1:?run directory}"
DMG_SRC="${2:?path to the release DMG}"
SRC="${3:?checkout with docs/acceptance and the schema 3 fixture}"
: > "$RUN/job.started"   # the front half stops waiting for a start once this lands
[[ -n "${HOME:-}" ]] || { printf 'verify: launchd gave the job no HOME\n' >&2; printf '1\n' > "$RUN/job.status"; exit 1; }
export PATH=/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH
APP="/Applications/Materialize 3D.app"
BIN="$APP/Contents/MacOS/materialize-3d"
H=$RUN/home
DATA="$H/Library/Application Support/com.aojdevstudio.materialize3d"
HDR="$RUN/mcp.headers"
mkdir -p "$RUN/evidence" "$DATA" "$H/Applications"
ln -s "$HOME/Applications/BambuStudio-02.08.02.61" "$H/Applications/BambuStudio-02.08.02.61"
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$RUN/evidence/actions.log"; }

# Both are throwaway and live for this run only; neither ever reaches argv.
KCPASS="$(openssl rand -hex 24)"
TOKEN=""
LOGSTART="$(date '+%Y-%m-%d %H:%M:%S')"
TERMINALS_AT_START="$(pgrep -x Terminal 2>/dev/null | tr '\n' ' ' || true)"
log "run $RUN, throwaway keychain password generated (${#KCPASS} hex chars), Terminal pids at start: ${TERMINALS_AT_START:-none}"

PID=""; MNT=""
THROWAWAY=()
list_now() { security list-keychains -d user | tr -d ' "' | tr '\n' ' '; }
ORIG_DEFAULT="$(security default-keychain -d user | sed 's/^ *"//; s/"$//')"
ORIG_LIST_STR="$(list_now)"
ORIG_LIST=()
while IFS= read -r l; do l="${l#"${l%%[![:space:]]*}"}"; l="${l#\"}"; l="${l%\"}"; [[ -n "$l" ]] && ORIG_LIST+=("$l"); done < <(security list-keychains -d user)

redact() {
  local s="$1"
  s="${s//$KCPASS/<password>}"
  if [[ -n "$TOKEN" ]]; then s="${s//$TOKEN/<token>}"; fi
  printf '%s' "$s"
}
# security(1) reads a whole command line from stdin in interactive mode, so a
# password given this way never reaches argv, ps(1), or the audit record. The
# quoted arguments also prove the -i parser honours quoting before anything
# depends on it: a literal-quote parser leaves no keychain file behind.
sec() { # <what> <security command line>
  local what="$1" line="$2" out rc=0
  out="$(printf '%s\n' "$line" | HOME="$H" security -i 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then log "FAIL $what: security exited $rc: $(redact "$out")"; exit 1; fi
  log "$what: ok"
}

launch() {
  local before p
  before=$(pgrep -f "$BIN" | tr '\n' ' ' || true)
  open -n -g --env HOME="$H" "$APP"
  for _ in $(seq 1 60); do
    for p in $(pgrep -f "$BIN" || true); do [[ " $before " == *" $p "* ]] || PID=$p; done
    [[ -n "$PID" ]] && break; sleep 0.5
  done
  [[ -n "$PID" ]] || { log "FAIL the app did not start"; exit 1; }
  sleep 4
  kill -0 "$PID" 2>/dev/null || { log "FAIL the app exited after launch"; exit 1; }
}
quit() {
  [[ -n "$PID" ]] || return 0
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || { PID=""; return 0; }; sleep 0.25; done
  kill -9 "$PID" 2>/dev/null || true; PID=""
}

# A prompt that has already been dismissed leaves no process to find, so count
# the prompts securityd recorded over this run instead of looking for one now.
# /usr/bin/log by full path: log() above would otherwise shadow it, and its own
# output repeats the predicate, so the count would match itself.
# The anchor drops log(1)'s "Timestamp ..." column header, which is on stdout.
prompt_count() {
  /usr/bin/log show --start "$LOGSTART" --style compact --info \
    --predicate 'process == "securityd" AND eventMessage CONTAINS "displaying keychain prompt"' 2>/dev/null \
    | grep -cE '^[0-9].*displaying keychain prompt' || true
}
new_terminals() {
  local p out=""
  for p in $(pgrep -x Terminal 2>/dev/null || true); do
    case " $TERMINALS_AT_START " in *" $p "*) ;; *) out="$out$p " ;; esac
  done
  printf '%s' "${out% }"
}
unattended() { # <where in the run>
  local n t
  n="$(prompt_count)"; t="$(new_terminals)"
  log "$1: keychain prompts $n, new Terminal pids ${t:-none}"
  if [[ "$n" != 0 || -n "$t" ]]; then log "FAIL the run was not unattended"; exit 1; fi
}

new_keychain() { # <path>; created, unlocked in this desktop session, and thrown away on exit
  local kc="$1" name
  name="$(basename "$kc" .keychain-db)"
  mkdir -p "$H/Library/Keychains" "$H/Library/Preferences"
  sec "create the $name keychain" "create-keychain -p $KCPASS \"$kc\""
  [[ -f "$kc" ]] || { log "FAIL security -i did not create $kc"; exit 1; }
  THROWAWAY+=("$kc")
  HOME="$H" security set-keychain-settings "$kc"
  sec "unlock the $name keychain" "unlock-keychain -p $KCPASS \"$kc\""
  HOME="$H" security list-keychains -d user -s "$kc"
  HOME="$H" security default-keychain -d user -s "$kc"
}

# Idempotent: the body calls it once the checks are done, and the trap calls it
# again on any early exit.
restore() {
  quit || true
  if [[ -n "$MNT" ]]; then hdiutil detach "$MNT" >/dev/null 2>&1 || true; MNT=""; fi
  if [[ ${#THROWAWAY[@]} -gt 0 ]]; then HOME="$H" security delete-keychain "${THROWAWAY[@]}" >/dev/null 2>&1 || true; fi
  # The keychain work all ran with HOME pointed at the throwaway home, so the
  # real user's settings should not have moved; put them back if they did.
  if [[ "$(security default-keychain -d user 2>/dev/null | sed 's/^ *"//; s/"$//')" != "$ORIG_DEFAULT" ]]; then
    security default-keychain -d user -s "$ORIG_DEFAULT" >/dev/null 2>&1 || true
  fi
  if [[ ${#ORIG_LIST[@]} -gt 0 && "$(list_now)" != "$ORIG_LIST_STR" ]]; then
    security list-keychains -d user -s "${ORIG_LIST[@]}" >/dev/null 2>&1 || true
  fi
  rm -f "$HDR"
}
# The result file is the front half's completion signal, so it is written once,
# at the real end, and carries the status the front half exits with.
finish() {
  local rc=$?
  trap - EXIT
  restore
  printf '%s\n' "$rc" > "$RUN/job.status"
}
trap finish EXIT
trap 'log "the job was terminated"; exit 143' INT TERM

log "== download: Gatekeeper on a quarantined copy"
DMG="$RUN/$(basename "$DMG_SRC")"
cp "$DMG_SRC" "$DMG"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$DMG"
log "dmg sha256 $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
spctl --assess --type open --context context:primary-signature -vv "$DMG" 2>&1 | tee -a "$RUN/evidence/actions.log"
xcrun stapler validate "$DMG" 2>&1 | tail -1 | tee -a "$RUN/evidence/actions.log"

log "== open the DMG and drag the app to Applications"
MNT="$(mktemp -d /tmp/m3d-dmg.XXXXXX)"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
log "dmg contents: $(cd "$MNT" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | sort | tr '\n' ' ')"
log "Applications link -> $(readlink "$MNT/Applications")"
[[ -d "$APP" ]] && { pgrep -f "$BIN" >/dev/null && { log "FAIL the app is running"; exit 1; }; rm -rf "$APP"; }
ditto "$MNT/Materialize 3D.app" "$APP"
hdiutil detach "$MNT" >/dev/null; MNT=""
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$APP"
spctl --assess --type execute -vv "$APP" 2>&1 | tee -a "$RUN/evidence/actions.log"
syspolicy_check distribution "$APP" 2>&1 | tail -2 | tee -a "$RUN/evidence/actions.log" || true
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "^(Identifier|Authority=Developer|TeamIdentifier|Runtime)" | tee -a "$RUN/evidence/actions.log"
log "binary sha256 $(shasum -a 256 "$BIN" | cut -d' ' -f1), archs $(lipo -archs "$BIN"), min macOS $(plutil -extract LSMinimumSystemVersion raw "$APP/Contents/Info.plist")"
log "bundle files: $(cd "$APP" && find . -type f | sed 's|^\./||' | sort | tr '\n' ' ')"
strings "$BIN" > "$RUN/strings.txt"
if grep -qE 'M3D_E2E_(TOKEN|PORT|DATA_DIR)|__M3D_E2E_DIALOGS__' "$RUN/strings.txt"; then log "FAIL harness strings"; exit 1; fi
log "no e2e harness strings in the binary"
# The first launch of a downloaded app waits for a person to confirm the
# internet-download prompt; this unattended check clears the flag after the
# Gatekeeper assessment above, the same state a person reaches by clicking Open.
xattr -d com.apple.quarantine "$APP"

log "== existing data from schema 3 migrates on first launch"
db_state() {
  printf 'version %s, history %s, printers %s, settings %s' \
    "$(sqlite3 "$DATA/materialize.db" 'pragma user_version')" \
    "$(sqlite3 "$DATA/materialize.db" 'select count(*) from print_history')" \
    "$(sqlite3 "$DATA/materialize.db" 'select count(*) from printer_configs')" \
    "$(sqlite3 "$DATA/materialize.db" 'select count(*) from settings')"
}
WANT_VERSION="$(sed -n 's/.*pub const SCHEMA_VERSION: i32 = \([0-9][0-9]*\);.*/\1/p' "$SRC/src-tauri/src/database.rs")"
[[ -n "$WANT_VERSION" ]] || { log "FAIL no SCHEMA_VERSION in $SRC/src-tauri/src/database.rs"; exit 1; }
sqlite3 "$DATA/materialize.db" < "$SRC/src-tauri/tests/fixtures/db/main-schema-v3.sql"
seeded="$(db_state)"
log "seeded: $seeded"
launch; quit
after="$(db_state)"
log "after launch: $after"
[[ "$after" == "version $WANT_VERSION, ${seeded#version * }" ]] \
  || { log "FAIL migration: expected version $WANT_VERSION with the seeded rows (${seeded#version * }), got $after"; exit 1; }

log "== MCP stays off without the setting"
launch
if lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1; then log "FAIL MCP listening by default"; exit 1; fi
log "nothing listens on 45373"; quit

log "== the app stores its own credential and reads it back after a relaunch"
KC1="$H/Library/Keychains/app-written.keychain-db"
new_keychain "$KC1"
sqlite3 "$DATA/materialize.db" "insert or replace into settings (key, value, updated_at) values ('mcp.enabled', 'true', datetime('now'))"
launch
for _ in $(seq 1 30); do lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 || { log "FAIL MCP did not start on first enable"; exit 1; }
item1="$(HOME="$H" security find-generic-password -s com.materialize3d -a mcp:token "$KC1" 2>&1 | grep -E '"mdat"|"cdat"' | tr -s ' ' | tr '\n' ' ')"
log "launch 1: listening on $(lsof -nP -iTCP:45373 -sTCP:LISTEN | awk 'NR>1{print $9}'), keychain item written by the app: $item1"
unattended "launch 1"
quit; launch
for _ in $(seq 1 30); do lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
item2="$(HOME="$H" security find-generic-password -s com.materialize3d -a mcp:token "$KC1" 2>&1 | grep -E '"mdat"|"cdat"' | tr -s ' ' | tr '\n' ' ')"
log "launch 2: listening $(lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 && echo yes || echo no), item unchanged: $([[ "$item1" == "$item2" ]] && echo yes || echo "no ($item2)"), items in keychain: $(HOME="$H" security dump-keychain "$KC1" 2>/dev/null | grep -c '^keychain:')"
lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 || { log "FAIL MCP did not start after relaunch"; exit 1; }
[[ -n "$item1" && "$item1" == "$item2" ]] || { log "FAIL the app's keychain item changed after relaunch"; exit 1; }
unattended "launch 2"
quit

log "== build the acceptance sign through MCP with a known token"
KC2="$H/Library/Keychains/seeded.keychain-db"
new_keychain "$KC2"
TOKEN="$(openssl rand -hex 32)"
sec "seed the MCP token" "add-generic-password -s com.materialize3d -a mcp:token -w $TOKEN -T \"$APP\" \"$KC2\""
# Items that security(1) creates carry only Apple's partitions; add the app's
# team so the signed app may read the seeded token without a prompt.
TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
sec "add team $TEAM to the item's partition list" \
  "set-generic-password-partition-list -S \"apple-tool:,apple:,teamid:$TEAM\" -s com.materialize3d -a mcp:token -k $KCPASS \"$KC2\""
launch
for _ in $(seq 1 30); do lsof -nP -iTCP:45373 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
URL=http://127.0.0.1:45373/mcp
# "wrong" is a literal, not a credential; only the real token needs the file.
no_token="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{}' "$URL")"
wrong_token="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' -H 'content-type: application/json' -d '{}' "$URL")"
log "no token -> $no_token; wrong token -> $wrong_token"
[[ "$no_token" == 401 && "$wrong_token" == 401 ]] || { log "FAIL the MCP endpoint must answer 401 without a valid token"; exit 1; }
SESSION=""
# curl reads every header from this mode-600 file, so the token never reaches argv.
headers() {
  ( umask 077
    { printf 'Authorization: Bearer %s\n' "$TOKEN"
      printf 'Accept: application/json, text/event-stream\n'
      printf 'content-type: application/json\n'
      if [[ -n "$SESSION" ]]; then printf 'Mcp-Session-Id: %s\n' "$SESSION"; fi
    } > "$HDR" )
}
rpc() {
  curl -s -D "$RUN/h" -H "@$HDR" -d "$1" "$URL" \
    | python3 -c 'import sys
t=sys.stdin.read(); d=[l[5:].strip() for l in t.splitlines() if l.startswith("data:") and l[5:].strip()]
print(d[0] if d else t.strip())'
}
headers
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-verify","version":"0"}}}' >/dev/null
SESSION=$(grep -i '^mcp-session-id:' "$RUN/h" | awk '{print $2}' | tr -d '\r')
headers
rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null || true
tools="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import json,sys; print(" ".join(sorted(t["name"] for t in json.load(sys.stdin)["result"]["tools"])))')"
log "tools: $tools"
for t in $tools; do
  case "$t" in *approve*|*export*|*print_result*|*record_print*) log "FAIL MCP exposes $t; approval, export, and print results stay with a person"; exit 1 ;; esac
done
[[ " $tools " == *" build_sign "* ]] || { log "FAIL MCP does not expose build_sign"; exit 1; }
SPEC=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$SRC/docs/acceptance/p2s-test-sign.json")
START=$(date +%s)
rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"build_sign\",\"arguments\":{\"spec\":$SPEC}}}" > "$RUN/evidence/build_sign.json"
log "build took $(( $(date +%s) - START )) s"
unattended "build_sign"
build_ok=0
python3 - "$RUN/evidence/build_sign.json" <<'PY' | tee -a "$RUN/evidence/actions.log" || build_ok=$?
import json,sys
r=json.load(open(sys.argv[1]))["result"]; o=json.loads(r["content"][0]["text"]); s=o["revision"]
print(f"  isError={r.get('isError')} r{s['number']} build={s['build']} checks={s['checks_passed']}/{s['checks_total']} approval={s['approval']} print={s['print_validation']} requested_by={s['requested_by']}")
print(f"  package_sha256={s['package_sha256']}")
if r.get("isError") or s["build"] != "verified" or s["approval"] != "pending" or s["checks_passed"] != s["checks_total"]:
    sys.exit(1)
PY
[[ "$build_ok" == 0 ]] || { log "FAIL build_sign did not return a verified revision awaiting approval"; exit 1; }
# Approval stays with a person in the app: the endpoint must refuse to approve.
refusal="$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve_sign","arguments":{}}}')"
log "approve over MCP -> $(printf '%s' "$refusal" | head -c 140)"
printf '%s' "$refusal" | python3 -c 'import json,sys; sys.exit(0 if "error" in json.load(sys.stdin) else 1)' \
  || { log "FAIL the MCP endpoint accepted an approval"; exit 1; }
row="$(sqlite3 "$DATA/materialize.db" "select number, build_status, approval_status, print_status, requested_by from sign_revisions")"
log "db: $row"
[[ "$row" == "1|verified|pending|not_tested|external_mcp" ]] || { log "FAIL the stored revision is not a verified build awaiting a person's approval"; exit 1; }
REV=$(python3 -c 'import json,sys; print(json.loads(json.load(open(sys.argv[1]))["result"]["content"][0]["text"])["revision"]["revision_id"])' "$RUN/evidence/build_sign.json")
cp "$DATA/signs/$REV/preview.png" "$RUN/evidence/p2s-test-sign-preview.png" 2>/dev/null || true
quit

unattended "end of run"
# Read the real user's keychain state before the teardown runs: restore() puts a
# changed default keychain back, which would otherwise hide the leak this checks.
end_default="$(security default-keychain -d user | sed 's/^ *"//; s/"$//')"
end_list="$(list_now)"
restore
log "real user keychains untouched: default $end_default, list $end_list"
[[ "$end_default" == "$ORIG_DEFAULT" ]] || { log "FAIL the real default keychain changed"; exit 1; }
[[ "$end_list" == "$ORIG_LIST_STR" ]] || { log "FAIL the real keychain search list changed"; exit 1; }
log "done: $RUN"
