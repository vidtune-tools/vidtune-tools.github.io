#!/bin/sh
# One-time setup: self-host the conversion engines so they load from your own domain.
# Run from the site root:  sh setup-ffmpeg.sh      (needs Node.js / npm)
set -e
mkdir -p assets/ffmpeg/lib assets/ffmpeg/core assets/vendor
T=$(mktemp -d); cd "$T"
npm pack @ffmpeg/ffmpeg@0.12.10 @ffmpeg/core@0.12.10 lamejs@1.2.1 >/dev/null
for f in *.tgz; do mkdir "x-$f"; tar -xzf "$f" -C "x-$f"; done
cd - >/dev/null
cp -r "$T"/x-ffmpeg-ffmpeg-*/package/dist/esm/* assets/ffmpeg/lib/
cp "$T"/x-ffmpeg-core-*/package/dist/esm/ffmpeg-core.js "$T"/x-ffmpeg-core-*/package/dist/esm/ffmpeg-core.wasm assets/ffmpeg/core/
cp "$T"/x-lamejs-*/package/lame.min.js assets/vendor/lame.min.js
rm -rf "$T"
echo "Done. assets/ffmpeg/ and assets/vendor/lame.min.js are in place."
