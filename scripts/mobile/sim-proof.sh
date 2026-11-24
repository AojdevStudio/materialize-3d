#!/bin/zsh
# The mobile app's simulator proof: pairs from a QR picture, opens a chat's model files, relaunches, and resets the
# Keychain to show the pairing lived there. Screenshots land in <out>/attachments.
#
#   scripts/mobile/sim-proof.sh build <simulator-udid> <out>
#   scripts/mobile/sim-proof.sh test <simulator-udid> <pairing-qr.png> <out>
#
# A pairing code lasts 5 minutes, less than a first build, so build first, then show a new code and test with it.
# `test` erases the simulator's Keychain, so it runs only on a simulator made for the proof, named m3d-proof-*:
#   xcrun simctl create m3d-proof-iphone "iPhone 18 Pro"
# Erase it before each run, so the pairing picture is the newest in Photos. `test` needs M3D_COMPUTER, M3D_CHAT, M3D_LINE,
# and M3D_MODELS: the computer's name, a chat, a line of that chat, and its model files separated by `;`.
set -euo pipefail
mode=$1 device=$2
repo=${0:A:h:h:h}
project=$repo/src-mobile/gen/apple/materialize-3d-mobile.xcodeproj
# A simulator app needs a signature, even an ad hoc one, for the Keychain to take its items.
sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=)

case $mode in
build)
  out=${3:A}
  mkdir -p $out
  # A clean checkout has no Xcode project yet: Tauri's build fills Externals/ and assets/, and xcodegen writes the
  # project from project.yml (it is what `tauri ios init` uses too).
  apple=$repo/src-mobile/gen/apple
  mkdir -p $apple/Externals $apple/assets
  ( cd $apple && xcodegen generate --spec project.yml > $out/xcodegen.log )
  # Xcode's "Build Rust Code" step reads its options from a running `tauri ios build`. `--open` keeps one running
  # without building, and would open Xcode, so a stand-in `open` on PATH holds that back. Building through xcodebuild
  # also skips Tauri's check that the simulator runtime matches the SDK exactly, since Xcode builds for an older
  # runtime fine.
  shims=$(mktemp -d)
  printf '#!/bin/sh\nexit 0\n' > $shims/open && chmod +x $shims/open
  ( cd $repo/src-mobile && PATH=$shims:$PATH bunx tauri ios build --target aarch64-sim --debug --ci --open > $out/tauri.log 2>&1 ) &
  tauri=$!
  trap 'kill $tauri 2>/dev/null; rm -rf $shims' EXIT
  until grep -q "Opening Xcode" $out/tauri.log; do kill -0 $tauri || { cat $out/tauri.log; exit 1; }; sleep 1; done
  xcodebuild -project $project -scheme materialize-3d-mobile_iOS -sdk iphonesimulator -configuration debug \
    -derivedDataPath $out/derived -destination "id=$device" $sign build-for-testing > $out/build.log
  ;;
test)
  pairing_qr=${3:A} out=${4:A}
  : ${M3D_COMPUTER:?} ${M3D_CHAT:?} ${M3D_LINE:?} ${M3D_MODELS:?}
  line=$(xcrun simctl list devices | grep -F "($device)" || true)
  [[ ${line#"${line%%[![:space:]]*}"} == m3d-proof-* ]] || { echo "sim-proof: $device is not an m3d-proof-* simulator" >&2; exit 2; }
  xcrun simctl boot $device 2>/dev/null || true
  xcrun simctl addmedia $device $pairing_qr
  run() {
    rm -rf $out/$1.xcresult $out/attachments/$1
    local result=0
    TEST_RUNNER_M3D_COMPUTER=$M3D_COMPUTER TEST_RUNNER_M3D_CHAT=$M3D_CHAT TEST_RUNNER_M3D_LINE=$M3D_LINE TEST_RUNNER_M3D_MODELS=$M3D_MODELS \
      xcodebuild -project $project \
      -scheme materialize-3d-mobile_iOS -derivedDataPath $out/derived -destination "id=$device" $sign \
      -only-testing:materialize-3d-mobile_UITests/PairAndViewUITests/$2 -resultBundlePath $out/$1.xcresult \
      test-without-building > $out/$1.log || result=$?
    xcrun xcresulttool export attachments --path $out/$1.xcresult --output-path $out/attachments/$1 > /dev/null || echo "sim-proof: no attachments exported for $1" >&2
    (( result == 0 )) || { grep -E "error:|Test Case" $out/$1.log || tail -20 $out/$1.log; exit $result; }
  }
  run pair testPairFromAPictureOpenTheModelsAndRelaunch
  # Only after a pass: the reset shows the pairing lived in the Keychain.
  xcrun simctl keychain $device reset
  run keychain testAKeychainResetForgetsThePairing
  ;;
*)
  echo "usage: sim-proof.sh build <udid> <out> | test <udid> <pairing-qr.png> <out>" >&2
  exit 2
  ;;
esac
