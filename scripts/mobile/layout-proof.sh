#!/bin/zsh
# The phone and tablet layout proof: builds the app and its UI tests once with sim-proof.sh, then on each simulator
# starts a fresh scripted computer (sidecar/test/fixtures/scripted-computer.ts), adds its pairing code to Photos, and
# runs LayoutsAndRolesUITests. Screenshots land in <out>/<simulator>/attachments, and the computer's store and project
# folders, as the run left them, in <out>/<simulator>/computer, which the desktop app can open.
#
#   scripts/mobile/layout-proof.sh <out> <simulator-udid>...
#
# Use fresh simulators, so the pairing picture is the newest in Photos. The scripted computer serves phones on port
# $M3D_PHONE_PORT, 47381 when unset, and Tailscale Serve on this Mac must forward https://<this Mac>:<port> to
# http://127.0.0.1:<port>.
set -euo pipefail
out=${1:A}; shift
repo=${0:A:h:h:h}
project=$repo/src-mobile/gen/apple/materialize-3d-mobile.xcodeproj
port=${M3D_PHONE_PORT:-47381}
# A simulator app needs a signature, even an ad hoc one, for the Keychain to take its items.
sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=)
$repo/scripts/mobile/sim-proof.sh build $1 $out

computer=
trap '[ -n "$computer" ] && kill $computer 2>/dev/null' EXIT
failed=0
for device in "$@"; do
  run=$out/$device
  mkdir -p $run
  bun $repo/sidecar/test/fixtures/scripted-computer.ts --port $port --qr $run/pair-qr.png --dir $run/computer \
    --model $repo/src-tauri/tests/fixtures/bambu/cube-p2s-petg.3mf > $run/computer.log 2>&1 &
  computer=$!
  until grep -q pairUrl $run/computer.log; do kill -0 $computer || { cat $run/computer.log; exit 1; }; sleep 1; done
  xcrun simctl boot $device 2>/dev/null || true
  xcrun simctl addmedia $device $run/pair-qr.png
  xcodebuild -project $project -scheme materialize-3d-mobile_iOS -derivedDataPath $out/derived -destination "id=$device" $sign \
    -only-testing:materialize-3d-mobile_UITests/LayoutsAndRolesUITests -resultBundlePath $run/layouts.xcresult \
    test-without-building > $run/layouts.log || { grep -E "error:|Test Case" $run/layouts.log || true; failed=1; }
  # A run that failed before testing leaves no result bundle, and the next simulator still runs.
  if [ -d $run/layouts.xcresult ]; then
    xcrun xcresulttool export attachments --path $run/layouts.xcresult --output-path $run/attachments > /dev/null || failed=1
  fi
  kill $computer
  wait $computer 2>/dev/null || true
  computer=
done
exit $failed
