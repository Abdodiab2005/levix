#!/usr/bin/env bash
# Pack Levix source + production node_modules into assets/levix-app.zip.
# ffmpeg-static / esbuild / sharp stay out — they are desktop/native extras.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ASSETS="$ROOT/android/app/src/main/assets"
OUT="$ASSETS/levix-app.zip"
STAGE="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}/levix-app-stage"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "missing $ROOT/node_modules — run npm ci in the repo first" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE" "$ASSETS"

copy_tree() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
}

copy_tree "$ROOT/bin" "$STAGE/bin"
copy_tree "$ROOT/src" "$STAGE/src"
copy_tree "$ROOT/views" "$STAGE/views"
copy_tree "$ROOT/public" "$STAGE/public"
cp -a "$ROOT/app.cjs" "$ROOT/scheduler.cjs" "$ROOT/package.json" "$ROOT/LICENSE" "$STAGE/"
cp -a "$ROOT/android/host-boot.mjs" "$STAGE/boot.mjs"

mkdir -p "$STAGE/node_modules"
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude ffmpeg-static \
    --exclude esbuild \
    --exclude '@esbuild' \
    --exclude '@img' \
    --exclude sharp \
    --exclude '.cache' \
    --exclude '*.map' \
    "$ROOT/node_modules/" "$STAGE/node_modules/"
else
  cp -a "$ROOT/node_modules/." "$STAGE/node_modules/"
  rm -rf "$STAGE/node_modules/ffmpeg-static" \
    "$STAGE/node_modules/esbuild" \
    "$STAGE/node_modules/@esbuild" \
    "$STAGE/node_modules/@img" \
    "$STAGE/node_modules/sharp"
fi

# Native addons cannot be dlopen'd from filesDir on Android 10+.
find "$STAGE/node_modules" -name '*.node' -delete

rm -f "$OUT"
( cd "$STAGE" && zip -qr "$OUT" . )
ls -lh "$OUT"
echo "Wrote $OUT"
