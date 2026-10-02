#!/bin/sh
# Copies the conversion engines into assets/ so they are served from your own domain.
# Runs automatically in the GitHub workflow. Needs Node.js / npm.
set -e
ROOT=$(pwd)
mkdir -p assets/ffmpeg/lib assets/ffmpeg/core assets/vendor
T=$(mktemp -d)
cd "$T"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund @ffmpeg/ffmpeg@0.12.10 @ffmpeg/core@0.12.10 lamejs@1.2.1
cd "$ROOT"
cp -r "$T"/node_modules/@ffmpeg/ffmpeg/dist/esm/* assets/ffmpeg/lib/
cp "$T"/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js "$T"/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm assets/ffmpeg/core/
cp "$T"/node_modules/lamejs/lame.min.js assets/vendor/lame.min.js
test -s assets/ffmpeg/core/ffmpeg-core.wasm
test -s assets/ffmpeg/lib/index.js
test -s assets/vendor/lame.min.js
ls -la assets/ffmpeg/lib assets/ffmpeg/core assets/vendor
rm -rf "$T"
echo "Engines installed."
