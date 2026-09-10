#!/usr/bin/env bash
# Fetch a Bionic Node.js 24 ARM64 runtime and stage it for jniLibs.
# Uses Termux aarch64 debs as the build (NDK r29, Android 24). Termux is
# not required on the phone — only the ELF files are packaged into the APK.
set -euo pipefail

CACHE="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}"
WORKDIR="$CACHE/termux-node24"
RUNTIME="$CACHE/node-runtime/arm64-v8a"
BASE="https://packages.termux.dev/apt/termux-main"
PATCH="$CACHE/bin/patchelf"
PACKAGES_NEED=(nodejs-lts libc++ openssl c-ares libicu libsqlite zlib)

mkdir -p "$WORKDIR/debs" "$WORKDIR/root" "$CACHE/bin" "$RUNTIME"

if [ ! -x "$PATCH" ]; then
  echo "Downloading patchelf..."
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/patchelf.tgz" \
    "https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0-x86_64.tar.gz"
  tar -xzf "$tmp/patchelf.tgz" -C "$tmp"
  find "$tmp" -type f -name patchelf -exec cp {} "$PATCH" \;
  chmod +x "$PATCH"
  rm -rf "$tmp"
fi

echo "Fetching Termux package index..."
curl -fsSL "$BASE/dists/stable/main/binary-aarch64/Packages" -o "$WORKDIR/Packages"

python3 - "$WORKDIR/Packages" "$WORKDIR/urls.txt" "${PACKAGES_NEED[@]}" <<'PY'
import sys
index, out_path, *need = sys.argv[1:]
want = set(need)
seen = set()
rows = []
rec = {}
def flush():
    name = rec.get("Package")
    if name in want and name not in seen:
        seen.add(name)
        rows.append(rec["Filename"])
with open(index) as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            flush()
            rec = {}
            continue
        if ": " in line:
            k, v = line.split(": ", 1)
            rec.setdefault(k, v)
    flush()
missing = want - seen
if missing:
    raise SystemExit("missing Termux packages: " + ", ".join(sorted(missing)))
open(out_path, "w").write("\n".join(rows) + "\n")
for row in rows:
    print(row)
PY

while read -r fn; do
  [ -z "$fn" ] && continue
  base="$(basename "$fn")"
  dest="$WORKDIR/debs/$base"
  if [ ! -f "$dest" ]; then
    echo "GET $fn"
    curl -fL --retry 3 -o "$dest" "$BASE/$fn"
  fi
done < "$WORKDIR/urls.txt"

echo "Extracting debs..."
rm -rf "$WORKDIR/root"
mkdir -p "$WORKDIR/root"
for deb in "$WORKDIR/debs"/*.deb; do
  dpkg-deb -x "$deb" "$WORKDIR/root"
done

PREFIX="$WORKDIR/root/data/data/com.termux/files/usr"

copy_real() {
  local src="$1" dest="$2"
  cp -a "$(readlink -f "$src")" "$dest"
  chmod 755 "$dest"
}

echo "Staging $RUNTIME"
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
copy_real "$PREFIX/bin/node" "$RUNTIME/libnode.so"
copy_real "$PREFIX/lib/libc++_shared.so" "$RUNTIME/libc++_shared.so"
copy_real "$PREFIX/lib/libcares.so" "$RUNTIME/libcares.so"
copy_real "$PREFIX/lib/libsqlite3.so" "$RUNTIME/libsqlite3.so"
# Keep original SONAMEs. The Android linker matches DT_NEEDED/VERNEED
# filenames, so libcrypto.so.3 cannot be renamed to libcrypto.so.
copy_real "$PREFIX/lib/libcrypto.so.3" "$RUNTIME/libcrypto.so.3"
copy_real "$PREFIX/lib/libssl.so.3" "$RUNTIME/libssl.so.3"
copy_real "$PREFIX/lib/libicui18n.so.78" "$RUNTIME/libicui18n.so.78"
copy_real "$PREFIX/lib/libicuuc.so.78" "$RUNTIME/libicuuc.so.78"
copy_real "$PREFIX/lib/libicudata.so.78" "$RUNTIME/libicudata.so.78"
copy_real "$PREFIX/lib/libz.so.1" "$RUNTIME/libz.so.1"

for f in "$RUNTIME"/*; do
  "$PATCH" --set-rpath '$ORIGIN' "$f"
done

echo "Node runtime ready:"
ls -lh "$RUNTIME/libnode.so"
"$PATCH" --print-needed "$RUNTIME/libnode.so"
echo "Wrote $RUNTIME"
