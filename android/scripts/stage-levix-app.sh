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

if [ -d "$ROOT/frontend" ]; then
  echo "Building React frontend for Android app..."
  ( cd "$ROOT" && npm run build:frontend )
fi

DASHBOARD="$ROOT/public/dashboard"

# Every /dashboard/assets file index.html pulls in, as a path under public/.
dashboard_assets() {
  grep -o '/dashboard/assets/[A-Za-z0-9._-]*' "$DASHBOARD/index.html" | sort -u
}

# The panel is a Vite build: index.html carries no styling of its own and only
# links hashed asset files. A missing or half-finished frontend build packages
# an APK whose control panel renders with no CSS at all, which is invisible
# until someone installs it — so refuse to build one here.
if [ ! -f "$DASHBOARD/index.html" ]; then
  echo "missing $DASHBOARD/index.html — the frontend build did not produce a dashboard" >&2
  exit 1
fi

if [ -z "$(dashboard_assets | grep '\.css$' || true)" ]; then
  echo "$DASHBOARD/index.html links no stylesheet — refusing to package a styleless panel" >&2
  exit 1
fi

for ref in $(dashboard_assets); do
  if [ ! -f "$ROOT/public$ref" ]; then
    echo "missing $ROOT/public$ref, referenced by the dashboard — stale build output?" >&2
    exit 1
  fi
done

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

# The panel's HTML, JS and CSS have to be inside the archive the APK ships,
# not merely in the staging tree next to it. `zip -sf` indents each entry, and
# sed both trims that and drains the pipe — piping into `grep -q` instead would
# hand zip a SIGPIPE on the first match and, under pipefail, read as a failure.
listing="$(zip -sf "$OUT" | sed 's/^[[:space:]]*//')"
for ref in /dashboard/index.html $(dashboard_assets); do
  if ! grep -qxF "public$ref" <<<"$listing"; then
    echo "$OUT is missing public$ref" >&2
    exit 1
  fi
done

ls -lh "$OUT"
echo "Wrote $OUT ($(dashboard_assets | wc -l) dashboard assets verified inside)"
