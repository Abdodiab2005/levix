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
#   fetch-node-android.sh --check-pins [file]   # validate a pin file offline, stage nothing
#   fetch-node-android.sh --update-pins         # refresh pins from Termux, stage nothing
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
PIN_FILE="$SCRIPTS/termux-packages.lock"
SUPPORTED_NODE_MAJOR=24

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
# termux-packages.lock is one of the inputs: a pin change has to restage,
# or the runtime built from the previous pins stays in the APK.
RUNTIME_STAMP_FILE=".levix-stamp"
RUNTIME_STAMP_INPUTS=(build-ffmpeg-android.sh fetch-node-android.sh termux-packages.lock)

runtime_stamp() {
  local abi="$1" input
  echo "levix-runtime-stamp 1"
  echo "abi $abi"
  for input in "${RUNTIME_STAMP_INPUTS[@]}"; do
    echo "$input $(sha256sum "$SCRIPTS/$input" | cut -c1-16)"
  done
}

# One checker for the lock: offline validation, the rows the stager
# downloads, and the rewrite --update-pins does from the Termux indexes.
# The heredoc is quoted, so the Termux base URL and the supported major
# are passed in the environment rather than expanded into the program.
pins() {
  LEVIX_TERMUX_BASE="$BASE" LEVIX_NODE_MAJOR="$SUPPORTED_NODE_MAJOR" python3 - "$@" <<'PY'
import os
import re
import sys
import tempfile

ARCHES = ("aarch64", "arm")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
NODE_MAJOR = os.environ["LEVIX_NODE_MAJOR"]
HEADER = """# Termux packages the Android Node runtime is built from (ADR-001).
# fetch-node-android.sh downloads exactly these files, checks each sha256 and
# stages nothing else. Termux serves only the newest build of each package, so
# a pinned file stops downloading once Termux updates that package. Refresh
# the pins with
#   bash android/scripts/fetch-node-android.sh --update-pins
# which refuses a nodejs-lts that is not Node 24, then review the diff.
#
# arch package version sha256 url
"""


def upstream(version):
    # Drop an N: epoch and a trailing -N Termux revision.
    version = version.split(":", 1)[-1]
    return re.sub(r"-\d+$", "", version)


def parse_lock(path):
    rows = []
    problems = []
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split()
            if len(fields) != 5:
                problems.append(f"{path}:{lineno}: expected 5 fields, got {len(fields)}")
                continue
            arch, package, version, sha, url = fields
            rows.append(
                {
                    "line": lineno,
                    "arch": arch,
                    "package": package,
                    "version": version,
                    "sha256": sha,
                    "url": url,
                }
            )
    return rows, problems


def row_problems(rows, need, label):
    """Rules for a list of pin rows. Returns problem lines and writes nothing."""
    problems = []
    need_list = list(need)
    need_set = set(need_list)
    by_arch = {arch: {} for arch in ARCHES}
    for row in rows:
        arch = row["arch"]
        package = row["package"]
        sha = row["sha256"]
        url = row["url"]
        line = row.get("line")
        where = f"{label}:{line}" if line else f"{label}: {arch} {package}"
        if arch not in ARCHES:
            problems.append(f"{where}: arch {arch} is not aarch64 or arm")
        if package not in need_set:
            problems.append(f"{where}: package {package} is not in the need list")
        if SHA_RE.fullmatch(sha) is None:
            problems.append(f"{where}: sha256 is not 64 lowercase hex")
        name = url.rsplit("/", 1)[-1]
        if not url.startswith("https://") or not name.endswith(f"_{arch}.deb"):
            problems.append(
                f"{where}: url must start with https:// and end with _{arch}.deb"
            )
        if arch in ARCHES:
            slot = by_arch[arch]
            if package in slot:
                problems.append(f"{where}: duplicate {package} for {arch}")
            else:
                slot[package] = row
    for arch in ARCHES:
        for package in need_list:
            if package not in by_arch[arch]:
                problems.append(f"{label}: missing {package} for {arch}")
    node_versions = {}
    for arch in ARCHES:
        row = by_arch[arch].get("nodejs-lts")
        if row is None:
            continue
        ver = upstream(row["version"])
        if ver.split(".", 1)[0] != NODE_MAJOR:
            problems.append(
                f"{label}: nodejs-lts {ver} for {arch} is not Node {NODE_MAJOR}"
            )
        node_versions[arch] = ver
    if (
        "aarch64" in node_versions
        and "arm" in node_versions
        and node_versions["aarch64"] != node_versions["arm"]
    ):
        problems.append(
            "{lock}: aarch64 and arm pin different nodejs-lts versions "
            "({aarch} vs {arm})".format(
                lock=label,
                aarch=node_versions["aarch64"],
                arm=node_versions["arm"],
            )
        )
    return problems


def cmd_check(lockfile, need):
    rows, problems = parse_lock(lockfile)
    problems.extend(row_problems(rows, need, lockfile))
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        sys.exit(1)
    ver = next(
        upstream(row["version"])
        for row in rows
        if row["arch"] == "aarch64" and row["package"] == "nodejs-lts"
    )
    print(
        "Pins OK: nodejs-lts {ver} for aarch64 and arm, {n} pinned files".format(
            ver=ver, n=len(rows)
        )
    )


def cmd_rows(lockfile, arch):
    rows, problems = parse_lock(lockfile)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        sys.exit(1)
    for row in rows:
        if row["arch"] == arch:
            print("{sha} {url}".format(sha=row["sha256"], url=row["url"]))


def cmd_node_version(lockfile, arch):
    rows, problems = parse_lock(lockfile)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        sys.exit(1)
    for row in rows:
        if row["arch"] == arch and row["package"] == "nodejs-lts":
            print(upstream(row["version"]))
            return
    print("{path}: no nodejs-lts row for {arch}".format(path=lockfile, arch=arch), file=sys.stderr)
    sys.exit(1)


def parse_index(path):
    """First record per package name, same walk as the old resolver."""
    seen = {}
    rec = {}

    def flush():
        name = rec.get("Package")
        if name and name not in seen:
            seen[name] = dict(rec)

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                flush()
                rec = {}
                continue
            if ": " in line:
                key, value = line.split(": ", 1)
                rec.setdefault(key, value)
        flush()
    return seen


def write_atomic(path, text):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".termux-packages.lock.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def cmd_update(lockfile, index_aarch64, index_arm, need):
    indexes = {
        "aarch64": parse_index(index_aarch64),
        "arm": parse_index(index_arm),
    }
    missing = []
    for arch in ARCHES:
        for package in need:
            rec = indexes[arch].get(package)
            if (
                rec is None
                or not rec.get("Filename")
                or not rec.get("Version")
                or not rec.get("SHA256")
            ):
                missing.append("{pkg} for {arch}".format(pkg=package, arch=arch))
    if missing:
        print("missing Termux packages: " + ", ".join(missing), file=sys.stderr)
        sys.exit(1)
    offered = {}
    for arch in ARCHES:
        ver = upstream(indexes[arch]["nodejs-lts"]["Version"])
        offered[arch] = ver
        if ver.split(".", 1)[0] != NODE_MAJOR:
            print(
                "Termux offers nodejs-lts {ver} for {arch}, which is not Node {major}. "
                "The Android build stays on the current pins.".format(
                    ver=ver, arch=arch, major=NODE_MAJOR
                ),
                file=sys.stderr,
            )
            sys.exit(1)
    if offered["aarch64"] != offered["arm"]:
        print(
            "Termux offers nodejs-lts {aarch} for aarch64 and {arm} for arm. "
            "The Android build stays on the current pins.".format(
                aarch=offered["aarch64"], arm=offered["arm"]
            ),
            file=sys.stderr,
        )
        sys.exit(1)
    base = os.environ["LEVIX_TERMUX_BASE"].rstrip("/")
    new_rows = []
    for arch in ARCHES:
        for package in need:
            rec = indexes[arch][package]
            filename = rec["Filename"].lstrip("/")
            new_rows.append(
                {
                    "arch": arch,
                    "package": package,
                    "version": rec["Version"],
                    "sha256": rec["SHA256"].strip().lower(),
                    "url": base + "/" + filename,
                }
            )
    # Same rules as `check`. A bad index must not replace the lock on disk.
    problems = row_problems(new_rows, need, lockfile)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        sys.exit(1)
    old = {}
    if os.path.exists(lockfile):
        old_rows, _problems = parse_lock(lockfile)
        for row in old_rows:
            old[(row["arch"], row["package"])] = row
    body = [HEADER.rstrip("\n")]
    changes = []
    for row in new_rows:
        arch = row["arch"]
        package = row["package"]
        version = row["version"]
        sha = row["sha256"]
        url = row["url"]
        body.append("{arch} {pkg} {ver} {sha} {url}".format(
            arch=arch, pkg=package, ver=version, sha=sha, url=url
        ))
        prev = old.get((arch, package))
        if prev is None:
            changes.append("added {arch} {pkg} {ver}".format(arch=arch, pkg=package, ver=version))
        elif prev["version"] != version:
            changes.append(
                "changed {arch} {pkg} {old} -> {new}".format(
                    arch=arch, pkg=package, old=prev["version"], new=version
                )
            )
        elif prev["sha256"] != sha or prev["url"] != url:
            changes.append(
                "changed {arch} {pkg} {ver} sha256 or url".format(
                    arch=arch, pkg=package, ver=version
                )
            )
    write_atomic(lockfile, "\n".join(body) + "\n")
    if changes:
        for line in changes:
            print(line)
    else:
        print("pins unchanged")


command = sys.argv[1]
if command == "check":
    cmd_check(sys.argv[2], sys.argv[3:])
elif command == "rows":
    cmd_rows(sys.argv[2], sys.argv[3])
elif command == "node-version":
    cmd_node_version(sys.argv[2], sys.argv[3])
elif command == "update":
    cmd_update(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
else:
    print("unknown pins command: {cmd}".format(cmd=command), file=sys.stderr)
    sys.exit(1)
PY
}

if [ "${1:-}" = "--print-stamp" ]; then
  termux_arch "${2:?usage: fetch-node-android.sh --print-stamp <abi>}" > /dev/null
  runtime_stamp "$2"
  exit 0
fi

if [ "${1:-}" = "--check-pins" ]; then
  pins check "${2:-$PIN_FILE}" "${PACKAGES_NEED[@]}"
  exit 0
fi

if [ "${1:-}" = "--update-pins" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$BASE/dists/stable/main/binary-aarch64/Packages" -o "$tmp/Packages-aarch64"
  curl -fsSL "$BASE/dists/stable/main/binary-arm/Packages" -o "$tmp/Packages-arm"
  pins update "$PIN_FILE" "$tmp/Packages-aarch64" "$tmp/Packages-arm" "${PACKAGES_NEED[@]}"
  pins check "$PIN_FILE" "${PACKAGES_NEED[@]}"
  exit 0
fi

pins check "$PIN_FILE" "${PACKAGES_NEED[@]}"

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

  echo "==> [$ABI] fetching pinned Termux $ARCH packages..."
  # A process substitution would drop the exit status of `pins rows`.
  # The assignment fails the script (set -e) before any download.
  pinned_rows="$(pins rows "$PIN_FILE" "$ARCH")"
  row_count=0
  while read -r sha url; do
    [ -z "${url:-}" ] && continue
    row_count=$((row_count + 1))
  done <<< "$pinned_rows"
  if [ "$row_count" -ne "${#PACKAGES_NEED[@]}" ]; then
    printf '%s\n' "$ARCH: $PIN_FILE has $row_count pinned files, expected ${#PACKAGES_NEED[@]}" >&2
    exit 1
  fi
  pinned_debs=()
  while read -r sha url; do
    [ -z "${url:-}" ] && continue
    dest="$WORKDIR/debs/$(basename "$url")"
    pinned_debs+=("$dest")
    if [ -f "$dest" ]; then
      have="$(sha256sum "$dest" | cut -c1-64)"
      if [ "$have" = "$sha" ]; then
        echo "reuse $dest"
        continue
      fi
    fi
    echo "GET $url"
    if ! curl -fL --retry 3 -o "$dest.part" "$url"; then
      rm -f "$dest.part"
      printf '%s\n' "Download failed: $url" >&2
      printf '%s\n' "Termux serves only the newest build of each package, so this pin must be refreshed with: bash android/scripts/fetch-node-android.sh --update-pins" >&2
      printf '%s\n' "That refuses a nodejs-lts that is not Node ${SUPPORTED_NODE_MAJOR}. Review the lock diff." >&2
      exit 1
    fi
    have="$(sha256sum "$dest.part" | cut -c1-64)"
    if [ "$have" != "$sha" ]; then
      rm -f "$dest.part"
      printf '%s\n' "sha256 mismatch for $url" >&2
      printf '%s\n' "expected $sha" >&2
      printf '%s\n' "actual   $have" >&2
      exit 1
    fi
    mv "$dest.part" "$dest"
  done <<< "$pinned_rows"

  # Drop cached .debs this arch did not pin. The cache survives across runs,
  # and extracting every .deb in it would stage stale libraries over the
  # pinned ones (libsqlite has no SONAME, so an old file is an extra .so).
  for deb in "$WORKDIR/debs"/*.deb; do
    [ -f "$deb" ] || continue
    keep=0
    for pinned in "${pinned_debs[@]:-}"; do
      [ "$deb" = "$pinned" ] && keep=1 && break
    done
    if [ "$keep" -eq 0 ]; then
      rm -f "$deb"
    fi
  done

  echo "==> [$ABI] extracting pinned debs..."
  rm -rf "$WORKDIR/root"
  mkdir -p "$WORKDIR/root"
  for dest in "${pinned_debs[@]}"; do
    dpkg-deb -x "$dest" "$WORKDIR/root"
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

  # process.version is stored as the C string "\0v<version>\0".
  expected_node="$(pins node-version "$PIN_FILE" "$ARCH")"
  python3 - "$RUNTIME/libnode.so" "$expected_node" "$SUPPORTED_NODE_MAJOR" <<'PY'
import sys
path, version, major = sys.argv[1:]
data = open(path, "rb").read()
needle = b"\0v" + version.encode("ascii") + b"\0"
if version.split(".", 1)[0] != major or needle not in data:
    print(f"{path}: expected Node {version} (major {major})", file=sys.stderr)
    sys.exit(1)
PY

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
    # Command substitution keeps patchelf's status. A process substitution
    # would hide a failure and this runtime would still be stamped.
    needed_list="$("$PATCH" --print-needed "$f")"
    while read -r need; do
      # A here-string always yields one read, so an empty list is a blank line.
      [ -z "$need" ] && continue
      case " libc.so libm.so libdl.so " in *" $need "*) continue ;; esac
      if [ ! -f "$RUNTIME/$need" ]; then
        echo "ERROR: $(basename "$f") needs $need but it was not staged" >&2
        missing=1
      fi
    done <<< "$needed_list"
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
