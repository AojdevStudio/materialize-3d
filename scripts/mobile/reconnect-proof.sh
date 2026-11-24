#!/bin/zsh
# The draft and reconnect proof on one simulator: builds the app, starts the computer of scripts/mobile/link-lever.ts
# (the real sidecar with scripted models, behind a link proxy), then runs scripts/mobile/sim-proof.sh's tests with the
# draft tests between pairing and the Keychain reset. Screenshots land in <out>/attachments.
#
#   scripts/mobile/reconnect-proof.sh <simulator-udid> <out> <tailnet-host> [proxy-port] [control-port]
#
# Use a fresh simulator named m3d-proof-* (sim-proof.sh refuses any other). Tailscale Serve on this Mac must forward the proxy port first, and can be removed after:
#   tailscale serve --bg --https=47391 http://127.0.0.1:47391
#   tailscale serve --https=47391 off
set -euo pipefail
device=$1 out=${2:A} host=$3 proxy=${4:-47391} control=${5:-47392}
repo=${0:A:h:h:h}
mkdir -p $out
$repo/scripts/mobile/sim-proof.sh build $device $out

bun $repo/scripts/mobile/link-lever.ts $out $host $proxy $control > $out/lever.log 2> $out/lever.err &
lever=$!
trap 'kill -INT $lever 2>/dev/null; wait $lever 2>/dev/null || true' EXIT
until grep -q '"ready":true' $out/lever.log; do kill -0 $lever || { cat $out/lever.err; exit 1; }; sleep 1; done
computer=$(sed -n 's/.*"computer":"\([^"]*\)".*/\1/p' $out/lever.log)

# The photo the draft takes: a drawn stand-in, so the proof needs no camera.
printf '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e8eef5"/><rect x="250" y="220" width="400" height="160" rx="40" fill="#3b7dd8"/><circle cx="330" cy="300" r="40" fill="#e8eef5"/></svg>' >| $out/clip-photo.svg
qlmanage -t -s 900 -o $out $out/clip-photo.svg > /dev/null
command mv -f $out/clip-photo.svg.png $out/clip-photo.png

M3D_COMPUTER=$computer M3D_CHAT="Desk cable clip" M3D_LINE="Desk cable clip" M3D_MODELS="base.stl;clip.stl" M3D_LINK_CONTROL=$control M3D_DRAFT_PHOTO=$out/clip-photo.png \
  $repo/scripts/mobile/sim-proof.sh test $device $out/pairing.png $out
