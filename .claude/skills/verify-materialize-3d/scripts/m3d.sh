#!/usr/bin/env bash
# Lifecycle for one Materialize 3D verification run on a Linux host with Xvfb,
# tauri-driver, and WebKitWebDriver (the Linux host). Drive the app with wd.ts.
#
#   m3d.sh up              build, start Xvfb + Vite + tauri-driver, print the run dir
#   m3d.sh doctor          read-only health check of the active run
#   m3d.sh close-inspector close the docked WebKit inspector (needs a wd.ts session)
#   m3d.sh file-dialog <abs-path>  answer the native "Open File" (existing file) or "Save File" (new file) dialog
#   m3d.sh record start    start an ffmpeg x11grab of the run's display
#   m3d.sh record stop     stop it; the MP4 lands in <run>/evidence/
#   m3d.sh down            stop everything this run started, delete scratch state, keep evidence
#
# Env: M3D_RUNS (default ~/m3d-verify), M3D_DISPLAY (reuse an existing X display
# such as :99 to watch over VNC; default starts a private Xvfb).
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RUNS=${M3D_RUNS:-$HOME/m3d-verify}
CURRENT=$RUNS/current
VITE_PORT=1420       # fixed by vite.config.ts (strictPort) and tauri.conf.json devUrl
DRIVER_PORT=4444
NATIVE_PORT=4445
BINARY=$ROOT/src-tauri/target/debug/materialize-3d

die() { echo "m3d: $*" >&2; exit 1; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
pid_of() { cat "$CURRENT/pids/$1" 2>/dev/null || true; }
alive() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }

# Waits up to $2 seconds for command $1 to succeed.
wait_for() {
  local check=$1 limit=$2
  for ((i = 0; i < limit * 4; i++)); do eval "$check" >/dev/null 2>&1 && return 0; sleep 0.25; done
  return 1
}

# Starts a command in its own session so `down` can kill exactly its process group.
spawn() {
  local name=$1; shift
  setsid "$@" >"$RUN/logs/$name.log" 2>&1 < /dev/null &
  echo $! >"$RUN/pids/$name"
}

stop_group() {
  local pid; pid=$(pid_of "$1")
  alive "$pid" || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  wait_for "! kill -0 $pid" 5 || kill -KILL -- "-$pid" 2>/dev/null || true
}

# Installs JS deps without touching tracked files. bun.lock on main lacks
# @tauri-apps/plugin-dialog, so bun resolves the newest 2.x and `tauri` rejects the
# mismatch with the Rust crate; pin the JS package to the version in Cargo.lock.
ensure_deps() {
  local want have
  want=$(awk '/^name = "tauri-plugin-dialog"/{getline; gsub(/[^0-9.]/, ""); print}' "$ROOT/src-tauri/Cargo.lock")
  have=$(jq -r .version "$ROOT/node_modules/@tauri-apps/plugin-dialog/package.json" 2>/dev/null || true)
  [[ -d "$ROOT/node_modules" && "$have" == "$want" ]] && return 0
  (cd "$ROOT" && bun install --no-save && bun add --no-save "@tauri-apps/plugin-dialog@$want") >"$RUN/logs/deps.log" 2>&1 \
    || die "dependency install failed; see $RUN/logs/deps.log"
}

up() {
  [[ -e "$CURRENT" ]] && die "run already active at $(readlink -f "$CURRENT"); run 'm3d.sh down' first"
  for tool in Xvfb tauri-driver WebKitWebDriver xdotool ffmpeg bun cargo jq ss curl setsid keyctl; do
    command -v "$tool" >/dev/null || die "missing $tool; this host cannot run verification (use the Linux host)"
  done
  for port in $VITE_PORT $DRIVER_PORT $NATIVE_PORT; do
    port_busy "$port" && die "port $port is in use by another instance; refusing to double-drive it"
  done

  RUN=$RUNS/$(date +%Y%m%d-%H%M%S)
  mkdir -p "$RUN"/{evidence,logs,pids,xdg/data,xdg/config,xdg/cache}
  ln -sfn "$RUN" "$CURRENT"

  ensure_deps
  echo "m3d: cargo build (incremental; first build takes several minutes)"
  cargo build --manifest-path "$ROOT/src-tauri/Cargo.toml" >"$RUN/logs/cargo.log" 2>&1 \
    || die "cargo build failed; see $RUN/logs/cargo.log"

  local display=${M3D_DISPLAY:-}
  if [[ -z "$display" ]]; then
    local n=90
    while [[ -e /tmp/.X11-unix/X$n || -e /tmp/.X$n-lock ]]; do n=$((n + 1)); done
    display=:$n
    spawn xvfb Xvfb "$display" -screen 0 1600x1000x24 -nolisten tcp
    wait_for "[[ -e /tmp/.X11-unix/X$n ]]" 10 || die "Xvfb $display did not start; see $RUN/logs/xvfb.log"
  fi

  (cd "$ROOT" && spawn vite bun run dev)
  wait_for "curl -sf http://localhost:$VITE_PORT/" 60 || die "Vite not answering on :$VITE_PORT; see $RUN/logs/vite.log"

  # XDG_* isolates the app's SQLite DB, library files, and WebKit storage per run.
  # Its own session keyring: the app stores API keys and the MCP token in the
  # kernel keyring, and the launching shell's keyring is revoked when an SSH
  # login ends, which would turn every credential read into "No matching entry".
  DISPLAY=$display XDG_DATA_HOME=$RUN/xdg/data XDG_CONFIG_HOME=$RUN/xdg/config XDG_CACHE_HOME=$RUN/xdg/cache \
    spawn driver keyctl session - tauri-driver --port "$DRIVER_PORT" --native-port "$NATIVE_PORT"
  wait_for "curl -sf http://127.0.0.1:$DRIVER_PORT/status" 20 || die "tauri-driver not answering; see $RUN/logs/driver.log"

  jq -n --arg run "$RUN" --arg display "$display" --arg binary "$BINARY" --arg rev "$(git -C "$ROOT" rev-parse --short HEAD)" \
    --argjson driverPort "$DRIVER_PORT" --argjson vitePort "$VITE_PORT" \
    '{run: $run, display: $display, binary: $binary, rev: $rev, driverPort: $driverPort, vitePort: $vitePort}' >"$RUN/env.json"
  echo "m3d: ready  run=$RUN  display=$display  rev=$(jq -r .rev "$RUN/env.json")"
}

doctor() {
  [[ -e "$CURRENT/env.json" ]] || { echo "doctor: no active run at $CURRENT"; exit 1; }
  RUN=$(readlink -f "$CURRENT")
  local ok=0 display rev
  display=$(jq -r .display "$RUN/env.json"); rev=$(jq -r .rev "$RUN/env.json")
  check() { if eval "$2" >/dev/null 2>&1; then echo "  ok    $1"; else echo "  FAIL  $1"; ok=1; fi; }
  echo "doctor: run=$RUN display=$display built-rev=$rev checkout-rev=$(git -C "$ROOT" rev-parse --short HEAD)"
  check "checkout HEAD matches the built revision" "[[ $rev == $(git -C "$ROOT" rev-parse --short HEAD) ]]"
  check "binary exists" "[[ -x $BINARY ]]"
  [[ -e "$RUN/pids/xvfb" ]] && check "Xvfb $display (ours) alive" "alive $(pid_of xvfb)"
  check "display $display present" "[[ -e /tmp/.X11-unix/X${display#:} ]]"
  check "Vite (ours) alive and serving :$VITE_PORT" "alive $(pid_of vite) && curl -sf http://localhost:$VITE_PORT/"
  check "tauri-driver (ours) alive on :$DRIVER_PORT" "alive $(pid_of driver) && curl -sf http://127.0.0.1:$DRIVER_PORT/status"
  if [[ -s "$RUN/session" ]]; then
    check "WebDriver session $(cat "$RUN/session") answers" \
      "curl -sf http://127.0.0.1:$DRIVER_PORT/session/$(cat "$RUN/session")/url | jq -e '.value | strings'"
    check "app DB is inside the run dir" "[[ -e $RUN/xdg/data/com.aojdevstudio.materialize3d/materialize.db ]]"
  else
    echo "  --    no WebDriver session yet (bun wd.ts session)"
  fi
  exit $ok
}

xdo() { DISPLAY=$(jq -r .display "$CURRENT/env.json") xdotool "$@"; }
viewport_height() { "$(dirname "$0")/wd.ts" eval "return innerHeight"; }

# Debug builds dock the WebKit inspector over the bottom 300px of the 1440x900
# window (lib.rs open_devtools); its close button sits at (15,614) on screen.
# The inspector docks a moment after page load and ignores clicks until painted,
# so wait for the docked viewport, then click until the viewport is full height.
close_inspector() {
  wait_for '[[ $(viewport_height) == 600 ]]' 10 || { echo "m3d: no docked inspector (viewport $(viewport_height))"; return 0; }
  for _ in 1 2 3 4 5; do
    sleep 1
    xdo mousemove 15 614 click 1
    wait_for '[[ $(viewport_height) == 900 ]]' 2 && { echo "m3d: inspector closed; viewport 1440x900"; return 0; }
  done
  die "inspector still docked (viewport height $(viewport_height))"
}

# Answers the native GTK "Open File" dialog by typing an absolute path into its
# location entry, the way a user does. GTK autocompletes only while the cursor is
# at the end of the text, and a common-prefix completion mangles fast typing, so
# the path is typed in front of a placeholder that is deleted afterwards.
# GTK keeps a mapped "Open File" window after closing, so this cannot observe the
# outcome; the caller proves it through the webview (e.g. design-toolbar appears).
file_dialog() {
  local path=${1:-} title
  [[ "$path" == /* ]] || die "file-dialog needs an absolute path"
  # An existing file answers "Open File"; a new file in an existing directory answers "Save File".
  if [[ -e "$path" ]]; then title="Open File"
  elif [[ -d "$(dirname "$path")" ]]; then title="Save File"
  else die "file-dialog needs an existing file, or a new file in an existing directory"; fi
  wait_for "xdo search --onlyvisible --name '^$title\$'" 10 || die "no $title dialog on the display"
  sleep 1
  if [[ $title == "Open File" ]]; then
    xdo key ctrl+l
    sleep 0.3
  fi
  xdo key ctrl+a
  xdo type "#"
  xdo key Home
  xdo type --delay 20 "$path"
  xdo key End BackSpace
  sleep 0.3
  xdo key Return
  echo "m3d: submitted $path to the $title dialog"
}

record() {
  RUN=$(readlink -f "$CURRENT")
  case ${1:-} in
    start)
      alive "$(pid_of ffmpeg)" && die "already recording"
      spawn ffmpeg ffmpeg -y -f x11grab -video_size 1600x1000 -framerate 15 -i "$(jq -r .display "$RUN/env.json")" \
        -pix_fmt yuv420p "$RUN/evidence/recording.mp4"
      echo "m3d: recording $RUN/evidence/recording.mp4" ;;
    stop)
      local pid; pid=$(pid_of ffmpeg)
      alive "$pid" && kill -INT -- "-$pid" && wait_for "! kill -0 $pid" 10
      echo "m3d: saved $RUN/evidence/recording.mp4" ;;
    *) die "usage: m3d.sh record start|stop" ;;
  esac
}

down() {
  [[ -e "$CURRENT" ]] || { echo "m3d: no active run"; return 0; }
  RUN=$(readlink -f "$CURRENT")
  if [[ -s "$RUN/session" ]]; then
    curl -sf -X DELETE "http://127.0.0.1:$DRIVER_PORT/session/$(cat "$RUN/session")" >/dev/null || true
  fi
  local pid; pid=$(pid_of ffmpeg)
  alive "$pid" && kill -INT -- "-$pid" && wait_for "! kill -0 $pid" 10
  for name in ffmpeg driver vite xvfb; do stop_group "$name"; done
  rm -rf "$RUN/xdg" "$RUN/pids" "$RUN/session"
  rm -f "$CURRENT"
  echo "m3d: down; evidence kept at $RUN/evidence"
}

case ${1:-} in
  up) up ;;
  doctor) doctor ;;
  record) record "${2:-}" ;;
  close-inspector) close_inspector ;;
  file-dialog) file_dialog "${2:-}" ;;
  down) down ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
