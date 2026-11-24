#!/bin/zsh
# The mobile app's simulator proof: pairs from a QR picture, opens a chat's model files, relaunches, and resets the
# Keychain to show the pairing lived there. Screenshots land in <out>/attachments.
#
#   scripts/mobile/sim-proof.sh build <simulator-udid> <out>
#   scripts/mobile/sim-proof.sh test <simulator-udid> <pairing-qr.png> <out>
#
# A pairing code lasts 5 minutes, less than a first build, so build first, then show a new code and test with it. Use a
# fresh simulator, so the pairing picture is the newest in Photos. `test` needs M3D_COMPUTER, M3D_CHAT, and M3D_LINE:
# the computer's name, a chat with model files, and a line of that chat.
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
  : ${M3D_COMPUTER:?} ${M3D_CHAT:?} ${M3D_LINE:?}
  xcrun simctl boot $device 2>/dev/null || true
  xcrun simctl addmedia $device $pairing_qr
  run() {
    rm -rf $out/$1.xcresult $out/attachments/$1
    TEST_RUNNER_M3D_COMPUTER=$M3D_COMPUTER TEST_RUNNER_M3D_CHAT=$M3D_CHAT TEST_RUNNER_M3D_LINE=$M3D_LINE \
      xcodebuild -project $project \
      -scheme materialize-3d-mobile_iOS -derivedDataPath $out/derived -destination "id=$device" $sign \
      -only-testing:materialize-3d-mobile_UITests/PairAndViewUITests/$2 -resultBundlePath $out/$1.xcresult \
      test-without-building > $out/$1.log || { grep -E "error:|Test Case" $out/$1.log; failed=1; }
    xcrun xcresulttool export attachments --path $out/$1.xcresult --output-path $out/attachments/$1 > /dev/null
  }
  failed=0
  run pair testPairFromAPictureOpenTheModelsAndRelaunch
  xcrun simctl keychain $device reset
  run keychain testAKeychainResetForgetsThePairing
  exit $failed
  ;;
*)
  echo "usage: sim-proof.sh build <udid> <out> | test <udid> <pairing-qr.png> <out>" >&2
  exit 2
  ;;
esac
