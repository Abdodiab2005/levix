#!/usr/bin/env bash
# Fetch Bionic Node.js 24 runtimes and stage them for jniLibs.
#
# Stages one directory per ABI under $CACHE/node-runtime:
#   arm64-v8a/     from Termux aarch64 packages
#   armeabi-v7a/   from Termux arm packages
#
# Termux is not required on the phone — only the ELF files are packaged into
# the APK. FFmpeg is built from source per ABI by build-ffmpeg-android.sh.
#
# Usage:
#   fetch-node-android.sh [abi ...]        # default: arm64-v8a armeabi-v7a
#   LEVIX_ANDROID_ABIS="arm64-v8a" ...     # same list via env (what Gradle reads)
#   fetch-node-android.sh --print-stamp <abi>   # print the stamp, stage nothing
#
# Each staged runtime gets a stamp (node-runtime/<abi>/.levix-stamp) naming
# the recipes it was built from; Gradle recomputes it and refuses to package a
# runtime whose stamp is missing or different. See runtime_stamp() below.
#
# Google Play requires every 64-bit ELF to be 16 KB page aligned when the app
# targets API 35+, so the script verifies arm64-v8a and fails the build
# otherwise: segment alignment, a RELRO region that does not share a 16 KB
# page with writable data, and an NDK of r28 or newer (older ones get the
# RELRO layout wrong, and Play warns about them). 32-bit ABIs are exempt.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# The stamp written into every staged runtime as $RUNTIME_STAMP_FILE.
# node-runtime/<abi>/ is only rebuilt when this script runs, and Gradle
# packages whatever is there — so a recipe change (FFmpeg gaining libwebp)
# used to ship the binaries staged before it, silently. The stamp records the
# recipes that produced the directory: the first 16 hex characters of each
# input's sha256 (the same key build-ffmpeg-android.sh caches its build under).
# android/app/build.gradle.kts recomputes it from the repo and fails the build
# when it is missing or different. RUNTIME_STAMP_FILE, RUNTIME_STAMP_INPUTS and
# the line format must match runtimeStampFile / runtimeStampInputs there;
# tests/android-runtime-stamp.test.mjs holds the two sides together.
RUNTIME_STAMP_FILE=".levix-stamp"
RUNTIME_STAMP_INPUTS=(build-ffmpeg-android.sh fetch-node-android.sh)

runtime_stamp() {
  local abi="$1" input
  echo "levix-runtime-stamp 1"
  echo "abi $abi"
  for input in "${RUNTIME_STAMP_INPUTS[@]}"; do
    echo "$input $(sha256sum "$SCRIPTS/$input" | cut -c1-16)"
  done
}

if [ "${1:-}" = "--print-stamp" ]; then
  termux_arch "${2:?usage: fetch-node-android.sh --print-stamp <abi>}" > /dev/null
  runtime_stamp "$2"
  exit 0
fi

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
  # Checks every staged ELF: right machine for the ABI, and for 64-bit (a
  # Google Play requirement for apps targeting API 35+) that it loads on a
  # 16 KB-page device:
  #   - every PT_LOAD aligned to at least 16 KB;
  #   - PT_GNU_RELRO does not end partway into a 16 KB page that also holds
  #     writable data — the loader's mprotect() rounds out to the page and
  #     would make that data read-only (NDK r27 and older linked this way);
  #   - built with NDK r28+, which is what Play reads from .note.android.ident.
  local runtime="$1" abi="$2"
  python3 - "$runtime" "$abi" <<'PY'
import re
import struct
import sys
from pathlib import Path

PT_LOAD, PT_NOTE, PT_GNU_RELRO = 1, 4, 0x6474E552
PAGE_16K = 16384
MIN_NDK = 28

runtime, abi = Path(sys.argv[1]), sys.argv[2]
expect_machine = {"arm64-v8a": 0xB7, "armeabi-v7a": 0x28}[abi]  # AArch64 / ARM


def program_headers(data, is64):
    if is64:
        phoff = struct.unpack_from("<Q", data, 0x20)[0]
        phentsize, phnum = struct.unpack_from("<HH", data, 0x36)
    else:
        phoff = struct.unpack_from("<I", data, 0x1C)[0]
        phentsize, phnum = struct.unpack_from("<HH", data, 0x2A)
    for i in range(phnum):
        at = phoff + i * phentsize
        if is64:
            p_type, _, offset, vaddr, _, filesz, memsz, align = struct.unpack_from("<IIQQQQQQ", data, at)
        else:
            p_type, offset, vaddr, _, filesz, memsz, _, align = struct.unpack_from("<IIIIIIII", data, at)
        yield {"type": p_type, "offset": offset, "vaddr": vaddr,
               "filesz": filesz, "memsz": memsz, "align": align}


def ndk_version(data, phdrs):
    """The NDK named in .note.android.ident, None when the ELF has no such note."""
    for ph in phdrs:
        if ph["type"] != PT_NOTE:
            continue
        at, end = ph["offset"], ph["offset"] + ph["filesz"]
        while at + 12 <= end:
            namesz, descsz, _ = struct.unpack_from("<III", data, at)
            name = data[at + 12:at + 12 + namesz].rstrip(b"\0")
            desc_at = at + 12 + ((namesz + 3) & ~3)
            if name == b"Android":
                if descsz < 4 + 64:
                    return "(unversioned)"  # old NDKs recorded only the API level
                return data[desc_at + 4:desc_at + 68].split(b"\0")[0].decode() or "unknown"
            at = desc_at + ((descsz + 3) & ~3)
    return None


failures = []
for so in sorted(runtime.glob("*.so")):
    data = so.read_bytes()
    if data[:4] != b"\x7fELF":
        failures.append(f"{so.name}: not an ELF")
        continue
    is64 = data[4] == 2
    machine = struct.unpack_from("<H", data, 0x12)[0]
    if machine != expect_machine:
        failures.append(f"{so.name}: wrong machine 0x{machine:x}")
        continue
    phdrs = list(program_headers(data, is64))
    loads = [ph for ph in phdrs if ph["type"] == PT_LOAD]
    min_align = PAGE_16K if is64 else 4096
    for ph in loads:
        if ph["align"] < min_align:
            failures.append(
                f"{so.name}: PT_LOAD aligned to {ph['align']} < {min_align} "
                f"({'16 KB page size requirement' if is64 else 'page size'})"
            )
            break
    if not is64:
        continue
    for relro in (ph for ph in phdrs if ph["type"] == PT_GNU_RELRO):
        relro_end = relro["vaddr"] + relro["memsz"]
        page_end = -(-relro_end // PAGE_16K) * PAGE_16K
        if relro_end == page_end:
            continue
        if any(ph["vaddr"] < page_end and ph["vaddr"] + ph["memsz"] > relro_end for ph in loads):
            failures.append(
                f"{so.name}: RELRO ends at 0x{relro_end:x}, inside a 16 KB page that also "
                f"holds writable data (crashes on 16 KB-page devices)"
            )
    ndk = ndk_version(data, phdrs)
    if ndk is not None:
        match = re.match(r"r(\d+)", ndk)
        if not match or int(match.group(1)) < MIN_NDK:
            failures.append(f"{so.name}: built with NDK {ndk}; Google Play needs r{MIN_NDK}+ for 16 KB devices")
if failures:
    print("ELF verification failed for " + abi + ":", file=sys.stderr)
    for f in failures:
        print("  " + f, file=sys.stderr)
    sys.exit(1)
print(f"ELF verification passed for {abi}: machine, alignment, RELRO and NDK OK")
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

  # FFmpeg links against Bionic only, so it takes no $ORIGIN runpath: staged
  # after the rewrite, it keeps exactly the segment layout the NDK linked.
  for f in "$RUNTIME"/*; do
    "$PATCH" --set-rpath '$ORIGIN' "$f"
  done
  bash "$SCRIPTS/build-ffmpeg-android.sh" "$ABI" "$RUNTIME/libffmpeg.so"

  verify_elfs "$RUNTIME" "$ABI"

  # Last, so a run that stops anywhere above leaves no stamp (the directory
  # was emptied at the start) and Gradle refuses the half-staged runtime.
  runtime_stamp "$ABI" > "$RUNTIME/$RUNTIME_STAMP_FILE"

  echo "==> [$ABI] runtime ready:"
  ls -lh "$RUNTIME" | tail -n +2
  "$PATCH" --print-needed "$RUNTIME/libnode.so"
done

echo "Done. Runtimes staged under $CACHE/node-runtime for: ${ABIS[*]}"
