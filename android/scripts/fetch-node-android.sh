#!/usr/bin/env bash
# Fetch Bionic Node.js 24 runtimes and stage them for jniLibs.
#
# Stages one directory per ABI under $CACHE/node-runtime:
#   arm64-v8a/     from Termux aarch64 packages
#   armeabi-v7a/   from Termux arm packages
#
# Termux is not required on the phone — only the ELF files are packaged into
# the APK. FFmpeg comes from the Khang-NT static Android builds (one per ABI).
#
# Usage:
#   fetch-node-android.sh [abi ...]        # default: arm64-v8a armeabi-v7a
#   LEVIX_ANDROID_ABIS="arm64-v8a" ...     # same list via env (what Gradle reads)
#
# Google Play requires every 64-bit ELF to be 16 KB page aligned when the app
# targets API 35+, so the script verifies alignment for arm64-v8a and fails
# the build otherwise. 32-bit ABIs are exempt from that requirement.
set -euo pipefail

CACHE="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}"
BASE="https://packages.termux.dev/apt/termux-main"
PATCH="$CACHE/bin/patchelf"
# Everything Node links against; must cover every DT_NEEDED of the node
# binary (verified below) apart from Bionic's own libc/libm/libdl.
PACKAGES_NEED=(nodejs-lts libc++ openssl c-ares libicu libsqlite zlib)

# ABI -> Termux repository architecture
termux_arch() {
  case "$1" in
    arm64-v8a) echo aarch64 ;;
    armeabi-v7a) echo arm ;;
    *) echo "unknown ABI: $1 (expected arm64-v8a or armeabi-v7a)" >&2; return 1 ;;
  esac
}

# Static FFmpeg builds (NDK, Opus & MJPEG/H.264 support) — per ABI.
ffmpeg_url() {
  case "$1" in
    arm64-v8a) echo "https://github.com/Khang-NT/ffmpeg-binary-android/releases/download/2018-07-31/arm64-v8a-lite.tar.bz2" ;;
    armeabi-v7a) echo "https://github.com/Khang-NT/ffmpeg-binary-android/releases/download/2018-07-31/armv7-a-lite.tar.bz2" ;;
  esac
}
ffmpeg_sha256() {
  case "$1" in
    arm64-v8a) echo "92ff6fb88d116f222fb309125e46f408ab3fd360cbb1d1786712b6fb9d0f3525" ;;
    armeabi-v7a) echo "c5f96375f629fe56916749601396ab3c299498c14aee1cbeca2ea64a8f10d371" ;;
  esac
}

if [ "$#" -gt 0 ]; then
  ABIS=("$@")
else
  ABIS=($(echo "${LEVIX_ANDROID_ABIS:-arm64-v8a armeabi-v7a}" | tr ',' ' '))
fi

mkdir -p "$CACHE/bin"

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

# Which library files each Termux package contributes. Globbed per arch so a
# soname bump upstream (libicu .so.78 -> .so.79, openssl .so.3 -> .so.4 ...)
# needs no change here — the new name is discovered and rewritten automatically.
stage_globs() {
  case "$1" in
    libc++) echo "lib/libc++_shared.so" ;;
    c-ares) echo "lib/libcares.so*" ;;
    libsqlite) echo "lib/libsqlite3.so*" ;;
    openssl) echo "lib/libcrypto.so* lib/libssl.so*" ;;
    libicu) echo "lib/libicui18n.so* lib/libicuuc.so* lib/libicudata.so*" ;;
    zlib) echo "lib/libz.so*" ;;
  esac
}

# libfoo.so.3 -> libfoo_3.so ; libfoo.so -> libfoo.so
# Android's NativeLibraryHelper ignores anything in lib/<abi>/ that does not
# end in .so, so numeric soname suffixes must be folded into the filename.
sanitize_name() {
  local base="$1"
  if [[ "$base" == *.so ]]; then
    echo "$base"
  else
    echo "${base%%.so*}_${base##*.so.}.so"
  fi
}

resolve_packages() {
  local arch="$1" workdir="$2"
  curl -fsSL "$BASE/dists/stable/main/binary-$arch/Packages" -o "$workdir/Packages"
  python3 - "$workdir/Packages" "$workdir/urls.txt" "${PACKAGES_NEED[@]}" <<'PY'
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
PY
}

verify_elfs() {
  # Checks every staged ELF: right machine for the ABI, and (64-bit only,
  # a Google Play requirement for apps targeting API 35+) PT_LOAD alignment
  # of at least 16 KB.
  local runtime="$1" abi="$2"
  python3 - "$runtime" "$abi" <<'PY'
import struct
import sys
from pathlib import Path

runtime, abi = Path(sys.argv[1]), sys.argv[2]
expect_machine = {"arm64-v8a": 0xB7, "armeabi-v7a": 0x28}[abi]  # AArch64 / ARM
failures = []
for so in sorted(runtime.glob("*.so")):
    with open(so, "rb") as fh:
        header = fh.read(64)
    if header[:4] != b"\x7fELF":
        failures.append(f"{so.name}: not an ELF")
        continue
    is64 = header[4] == 2
    machine = struct.unpack_from("<H", header, 0x12)[0]
    if machine != expect_machine:
        failures.append(f"{so.name}: wrong machine 0x{machine:x}")
        continue
    if is64:
        phoff = struct.unpack_from("<Q", header, 0x20)[0]
        phentsize, phnum = struct.unpack_from("<HH", header, 0x36)
        align_off = 48
    else:
        phoff = struct.unpack_from("<I", header, 0x1C)[0]
        phentsize, phnum = struct.unpack_from("<HH", header, 0x2A)
        align_off = 28
    min_align = 16384 if is64 else 4096
    with open(so, "rb") as fh:
        fh.seek(phoff)
        for i in range(phnum):
            ph = fh.read(phentsize)
            if not ph:
                break
            if struct.unpack_from("<I", ph, 0)[0] != 1:  # PT_LOAD
                continue
            p_align = struct.unpack_from("<Q" if is64 else "<I", ph, align_off)[0]
            if p_align < min_align:
                failures.append(
                    f"{so.name}: PT_LOAD aligned to {p_align} < {min_align} "
                    f"({'16 KB page size requirement' if is64 else 'page size'})"
                )
                break
if failures:
    print("ELF verification failed for " + abi + ":", file=sys.stderr)
    for f in failures:
        print("  " + f, file=sys.stderr)
    sys.exit(1)
print(f"ELF verification passed for {abi}: machine OK, alignments OK")
PY
}

for ABI in "${ABIS[@]}"; do
  ARCH="$(termux_arch "$ABI")"
  WORKDIR="$CACHE/termux-node24-$ARCH"
  RUNTIME="$CACHE/node-runtime/$ABI"
  mkdir -p "$WORKDIR/debs" "$WORKDIR/root"

  echo "==> [$ABI] resolving Termux $ARCH packages..."
  resolve_packages "$ARCH" "$WORKDIR"

  while read -r fn; do
    [ -z "$fn" ] && continue
    base="$(basename "$fn")"
    dest="$WORKDIR/debs/$base"
    if [ ! -f "$dest" ]; then
      echo "GET $fn"
      curl -fL --retry 3 -o "$dest" "$BASE/$fn"
    fi
  done < "$WORKDIR/urls.txt"

  echo "==> [$ABI] extracting debs..."
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

  echo "==> [$ABI] staging $RUNTIME"
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"
  copy_real "$PREFIX/bin/node" "$RUNTIME/libnode.so"

  # Stage every dependency library, renaming versioned SONAMEs
  # (libcrypto.so.3 -> libcrypto_3.so) as we go. Renames are keyed by the
  # library's SONAME — the string dependents carry in DT_NEEDED — which can
  # differ from the real filename (Termux ships libicui18n.so.78.3 with
  # SONAME libicui18n.so.78).
  RENAMES="$WORKDIR/renames.txt"
  : > "$RENAMES"
  staged_sources=()
  for pkg in "${PACKAGES_NEED[@]}"; do
    [ "$pkg" = "nodejs-lts" ] && continue
    for glob in $(stage_globs "$pkg"); do
      for src in "$PREFIX"/$glob; do
        [ -f "$src" ] || continue
        real="$(readlink -f "$src")"
        # Skip static archives and files already staged through another glob.
        case "$real" in *.a) continue ;; esac
        already=0
        for seen in "${staged_sources[@]:-}"; do
          [ "$seen" = "$real" ] && already=1 && break
        done
        [ "$already" = "1" ] && continue
        staged_sources+=("$real")
        soname="$("$PATCH" --print-soname "$real" 2>/dev/null || true)"
        if [ -z "$soname" ]; then
          # No SONAME in the ELF (some Termux libs are built without one):
          # dependents reference the plain .so symlink name instead.
          soname="$(basename "$src")"
        fi
        new="$(sanitize_name "$soname")"
        copy_real "$real" "$RUNTIME/$new"
        if [ "$new" != "$soname" ]; then
          "$PATCH" --set-soname "$new" "$RUNTIME/$new" < /dev/null
          echo "$soname,$new" >> "$RENAMES"
        fi
      done
    done
  done

  # Rewrite DT_NEEDED entries everywhere so every staged library refers to
  # the renamed files (libssl needs libcrypto, libicuuc needs libicudata,
  # node needs them all). No subprocess may inherit the loop's stdin, or it
  # eats the renames file and later entries are skipped silently.
  for f in "$RUNTIME"/*.so; do
    needed="$("$PATCH" --print-needed "$f" | tr '\n' ' ')"
    while IFS=, read -r old new; do
      [ -z "$old" ] && continue
      case " $needed " in
        *" $old "*)
          "$PATCH" --replace-needed "$old" "$new" "$f" < /dev/null
          needed="${needed/ $old / $new }"
          ;;
      esac
    done < "$RENAMES"
  done

  # Every non-system dependency of every staged ELF must now resolve to a
  # file in the runtime directory, or the on-device linker will fail.
  missing=0
  for f in "$RUNTIME"/*.so; do
    while read -r need; do
      case " libc.so libm.so libdl.so " in *" $need "*) continue ;; esac
      if [ ! -f "$RUNTIME/$need" ]; then
        echo "ERROR: $(basename "$f") needs $need but it was not staged" >&2
        missing=1
      fi
    done < <("$PATCH" --print-needed "$f")
  done
  if [ "$missing" != "0" ]; then
    exit 1
  fi

  # Stage the per-ABI static FFmpeg binary.
  FFMPEG_URL="$(ffmpeg_url "$ABI")"
  FFMPEG_SHA256="$(ffmpeg_sha256 "$ABI")"
  FFMPEG_ARCHIVE="$WORKDIR/ffmpeg-$ABI.tar.bz2"

  if [ ! -f "$FFMPEG_ARCHIVE" ] || ! echo "$FFMPEG_SHA256  $FFMPEG_ARCHIVE" | sha256sum -c --status 2>/dev/null; then
    echo "==> [$ABI] downloading FFmpeg..."
    curl -fL --retry 3 -o "$FFMPEG_ARCHIVE" "$FFMPEG_URL"
    echo "$FFMPEG_SHA256  $FFMPEG_ARCHIVE" | sha256sum -c -
  fi

  rm -rf "$WORKDIR/ffmpeg-$ABI"
  mkdir -p "$WORKDIR/ffmpeg-$ABI"
  tar -xjf "$FFMPEG_ARCHIVE" -C "$WORKDIR/ffmpeg-$ABI" ./ffmpeg
  cp -a "$WORKDIR/ffmpeg-$ABI/ffmpeg" "$RUNTIME/libffmpeg.so"
  chmod 755 "$RUNTIME/libffmpeg.so"

  for f in "$RUNTIME"/*; do
    "$PATCH" --set-rpath '$ORIGIN' "$f"
  done

  verify_elfs "$RUNTIME" "$ABI"

  echo "==> [$ABI] runtime ready:"
  ls -lh "$RUNTIME" | tail -n +2
  "$PATCH" --print-needed "$RUNTIME/libnode.so"
done

echo "Done. Runtimes staged under $CACHE/node-runtime for: ${ABIS[*]}"
