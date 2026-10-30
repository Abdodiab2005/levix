#!/usr/bin/env bash
# Pack Levix source and production node_modules into assets/levix-app.zip.
# Dependencies are installed from the lockfile into a separate directory.
# The archive is byte-reproducible.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ASSETS="$ROOT/android/app/src/main/assets"
OUT="$ASSETS/levix-app.zip"
STAGE="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}/levix-app-stage"
PROD="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}/levix-app-prod"

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

# Production dependencies from the lockfile, in a directory of their own.
# The repository install tree is not an input of the archive.
rm -rf "$PROD"
mkdir -p "$PROD"
cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$PROD/"
(
  cd "$PROD" || exit 1
  # --omit=dev: dev tools never ship.
  # --ignore-scripts: no install script is needed on Android.
  # --no-bin-links: no .bin symlinks.
  # --no-audit --no-fund: skip registry calls the install does not need.
  # --prefer-offline: the npm cache that the repository's own npm ci filled is enough.
  npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund --prefer-offline
)

mkdir -p "$STAGE/node_modules"
cp -a "$PROD/node_modules/." "$STAGE/node_modules/"
# Desktop FFmpeg; Android has libffmpeg.so and the loader tolerates its absence.
rm -rf "$STAGE/node_modules/ffmpeg-static"
# Baileys pulls sharp in as a peer dependency; its native parts are linux-x64 binaries that cannot load on Android, and v4.9.2 shipped without them (Baileys falls back when sharp is missing).
rm -rf "$STAGE/node_modules/sharp" "$STAGE/node_modules/@img"
# TypeScript declarations; Node never loads them.
rm -rf "$STAGE/node_modules/@types"
find "$STAGE/node_modules" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
# Native addons cannot be loaded from filesDir on Android 10+.
find "$STAGE/node_modules" -name '*.node' -delete
# Source maps were excluded before and are not runtime code.
find "$STAGE/node_modules" -name '*.map' -delete
# npm's own cache file.
rm -f "$STAGE/node_modules/.package-lock.json"

node "$ROOT/android/scripts/check-stage-deps.mjs" "$STAGE"
node "$ROOT/android/scripts/zip-tree.mjs" "$STAGE" "$OUT"

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
