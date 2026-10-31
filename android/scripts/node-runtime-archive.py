#!/usr/bin/env python3
"""Build, verify and extract the Android Node runtime archive.

fetch-node-android.sh stages from this one archive. It holds both ABIs, the
upstream licence texts and MANIFEST.json. There is no Termux fallback.
"""

import argparse
import base64
import binascii
import fnmatch
import hashlib
import io
import json
import lzma
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

NODE_MAJOR = "24"
SCHEMA = 1
ARCHES = ("aarch64", "arm")
PACKAGES = ("nodejs-lts", "libc++", "openssl", "c-ares", "libicu", "libsqlite", "zlib")
PLACEHOLDER_BYTES = (b"404: Not Found", b"404: Not Found\n", b"404: Not Found\r\n")
ARCHIVE_PREFIX = "levix-node-runtime-"
ARCHIVE_SUFFIX = "-android.tar.xz"
# Tests lower these in-process. They bound verify and extract, not the build.
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_TAR_BYTES = 512 * 1024 * 1024
MAX_TAR_MEMBERS = 1000
MAX_MEMBER_BYTES = 128 * 1024 * 1024
DECOMPRESS_CHUNK = 1024 * 1024

# Same patterns as stage_globs() in fetch-node-android.sh, which is the
# staging source of truth. Keep the two lists identical. usr/bin/node is
# selected beside these, matching that script's copy of $PREFIX/bin/node.
GLOB_PATTERNS = {
    "libc++": ("lib/libc++_shared.so",),
    "c-ares": ("lib/libcares.so*",),
    "libsqlite": ("lib/libsqlite3.so*",),
    "openssl": ("lib/libcrypto.so*", "lib/libssl.so*"),
    "libicu": ("lib/libicui18n.so*", "lib/libicuuc.so*", "lib/libicudata.so*"),
    "zlib": ("lib/libz.so*",),
}

# Upstream licence texts. The sha256 is of the file bytes we archive.
# The googlesource body is base64; its sha256 is of the decoded text.
LICENSES = (
    {
        "path": "licenses/nodejs-24.22.1-LICENSE",
        "package": "nodejs-lts",
        "version": "24.22.1",
        "url": "https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE",
        "sha256": "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace",
        "spdx": "MIT (with the notices of Node's bundled components)",
    },
    {
        "path": "licenses/openssl-3.6.5-LICENSE.txt",
        "package": "openssl",
        "version": "3.6.5",
        "url": "https://raw.githubusercontent.com/openssl/openssl/openssl-3.6.5/LICENSE.txt",
        "sha256": "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
        "spdx": "Apache-2.0",
    },
    {
        "path": "licenses/icu-78.3-LICENSE",
        "package": "libicu",
        "version": "78.3",
        "url": "https://raw.githubusercontent.com/unicode-org/icu/release-78.3/LICENSE",
        "sha256": "e55522d81edc687a341a4411e0776e54ca654e90147f354a90458aaced4116af",
        "spdx": "Unicode-3.0",
    },
    {
        "path": "licenses/libcxx-llvm-9f872551-LICENSE.TXT",
        "package": "libc++",
        "version": "30",
        "url": (
            "https://android.googlesource.com/toolchain/llvm-project/"
            "+/9f872551d3c681d06fd303b36f16ed5c274735eb/libcxx/LICENSE.TXT?format=TEXT"
        ),
        "sha256": "539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b",
        "spdx": "Apache-2.0 WITH LLVM-exception",
        "base64": True,
    },
    {
        "path": "licenses/sqlite-3.54.1-LICENSE.md",
        "package": "libsqlite",
        "version": "3.54.1",
        "url": "https://raw.githubusercontent.com/sqlite/sqlite/version-3.54.1/LICENSE.md",
        "sha256": "ee6af51062b30d532991face5164136ae6f84e265ecf8abe89dc69dac45ca1e7",
        "spdx": "blessing (public domain)",
    },
    {
        "path": "licenses/c-ares-1.34.9-LICENSE.md",
        "package": "c-ares",
        "version": "1.34.9",
        "url": "https://raw.githubusercontent.com/c-ares/c-ares/v1.34.9/LICENSE.md",
        "sha256": "460f5e768fda3752ca2169a95df062578a10fb126bfd65f3b9b1a1bed2f84807",
        "spdx": "MIT",
    },
    {
        "path": "licenses/zlib-1.3.2-LICENSE",
        "package": "zlib",
        "version": "1.3.2",
        "url": "https://raw.githubusercontent.com/madler/zlib/v1.3.2/LICENSE",
        "sha256": "e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2",
        "spdx": "Zlib",
    },
)


def sha256_hex(data):
    """Hex sha256 of bytes."""
    return hashlib.sha256(data).hexdigest()


def dump_manifest(manifest):
    """Canonical manifest bytes: sorted keys, indent 2, trailing newline."""
    return (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")


def die(message):
    """Print one line to stderr and exit 1."""
    print(message, file=sys.stderr)
    raise SystemExit(1)


def finish(problems):
    """Exit 1 with one stderr line per problem."""
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        raise SystemExit(1)


def upstream_version(version):
    """Drop an N: epoch and a trailing -N Termux revision."""
    version = version.split(":", 1)[-1]
    return re.sub(r"-\d+$", "", version)


def url_basename(url):
    """Final path segment of a URL, without a query string."""
    return url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]


def parse_lock(path):
    """Parse a termux-packages.lock file. Returns (rows, problem lines)."""
    rows = []
    problems = []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        return [], [f"cannot read lock: {exc}"]
    for lineno, raw in enumerate(text.splitlines(), 1):
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


def download(url):
    """GET url and return the response body."""
    request = urllib.request.Request(url, headers={"User-Agent": "levix-node-runtime-archive"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        die(f"download failed: {url} ({exc.code})")
    except urllib.error.URLError as exc:
        die(f"download failed: {url} ({exc.reason})")


def acquire(url, dest, expected, decode_base64=False):
    """Return dest's bytes, downloading url to a .part file when the cache misses.

    A googlesource body is base64; the sha256 is of the decoded text. A mismatch
    exits 1 with the expected and actual hash.
    """
    dest = Path(dest)
    if dest.is_file() and sha256_hex(dest.read_bytes()) == expected:
        return dest.read_bytes()
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = download(url)
    if decode_base64:
        try:
            data = base64.b64decode(data, validate=False)
        except binascii.Error as exc:
            die(f"base64 decode failed for {url} ({exc})")
    part = Path(str(dest) + ".part")
    part.write_bytes(data)
    have = sha256_hex(part.read_bytes())
    if have != expected:
        part.unlink()
        print(f"sha256 mismatch for {url}", file=sys.stderr)
        print(f"expected {expected}", file=sys.stderr)
        print(f"actual   {have}", file=sys.stderr)
        raise SystemExit(1)
    os.replace(part, dest)
    return data


def extract_deb(deb, root):
    """Unpack one .deb with dpkg-deb. root is the extract directory."""
    try:
        subprocess.run(
            ["dpkg-deb", "-x", str(deb), str(root)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) else exc
        die(f"dpkg-deb failed for {deb}: {detail}")


def termux_usr(root):
    """The Termux prefix inside a dpkg-deb extract, matching PREFIX in the shell script."""
    return Path(root) / "data" / "data" / "com.termux" / "files" / "usr"


def glob_paths(usr, pattern):
    """Match one stage_globs pattern relative to the Termux prefix.

    Patterns are one directory deep, the same shape the shell expands.
    """
    directory_name, name_pattern = pattern.split("/", 1)
    directory = usr / directory_name
    if not directory.is_dir():
        return []
    found = [entry for entry in directory.iterdir() if fnmatch.fnmatch(entry.name, name_pattern)]
    found.sort(key=lambda item: item.name)
    return found


def resolve_link(parent, target, boundary):
    """Resolve one relative symlink lexically. Raise ValueError if it leaves boundary."""
    if os.path.isabs(target):
        raise ValueError("absolute")
    current = parent
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if current == boundary or (current != boundary and boundary not in current.parents):
                raise ValueError("escape")
            current = current.parent
            if current != boundary and boundary not in current.parents:
                raise ValueError("escape")
            continue
        current = current / part
    if current != boundary and boundary not in current.parents:
        raise ValueError("escape")
    return current


def follow_symlinks(start, boundary):
    """Walk a symlink chain inside boundary. Return (regular file, [(link, raw target)])."""
    current = start
    chain = []
    for _ in range(16):
        if not current.is_symlink():
            if not current.is_file():
                raise ValueError("not a file")
            return current, chain
        raw = os.readlink(current)
        nxt = resolve_link(current.parent, raw, boundary)
        chain.append((current, raw))
        current = nxt
    raise ValueError("loop")


def file_entry(path, package):
    """Manifest fields for a regular file, plus its bytes. Mode keeps any execute bit."""
    data = path.read_bytes()
    mode = 0o755 if path.lstat().st_mode & 0o111 else 0o644
    return {
        "package": package,
        "type": "file",
        "data": data,
        "mode": mode,
        "sha256": sha256_hex(data),
        "size": len(data),
    }


def add_selected(path, package, selected, files_dir, boundary, label):
    """Record path. A symlink also records each target that stays inside boundary."""

    def rel(item):
        return item.relative_to(files_dir).as_posix()

    if path.is_symlink():
        try:
            final, chain = follow_symlinks(path, boundary)
        except ValueError as exc:
            die(f"symlink {rel(path)} points outside {label} ({exc})")
        for link, raw in chain:
            key = rel(link)
            if key not in selected:
                selected[key] = {"package": package, "type": "symlink", "target": raw}
        key = rel(final)
        if key not in selected:
            selected[key] = file_entry(final, package)
        return
    if path.is_file():
        key = rel(path)
        if key not in selected:
            selected[key] = file_entry(path, package)
        return
    die(f"{rel(path)} is not a file or a symlink")


def select_runtime(root, arch, arch_rows):
    """Pick usr/bin/node and the stage_globs matches, following symlinks inside usr/lib."""
    usr = termux_usr(root)
    files_dir = usr.parent
    selected = {}
    for row in arch_rows:
        package = row["package"]
        if package == "nodejs-lts":
            node = usr / "bin" / "node"
            if not node.is_symlink() and not node.is_file():
                die(f"{arch}: usr/bin/node is missing")
            add_selected(node, package, selected, files_dir, usr, "usr")
            continue
        patterns = GLOB_PATTERNS.get(package)
        if not patterns:
            die(f"{arch}: no stage patterns for {package}")
        boundary = usr / "lib"
        for pattern in patterns:
            matches = [
                item
                for item in glob_paths(usr, pattern)
                if item.is_symlink() or item.is_file()
            ]
            if not matches:
                die(f"{arch}: {package} pattern {pattern} matched nothing")
            for item in matches:
                add_selected(item, package, selected, files_dir, boundary, "usr/lib")
    entries = []
    blobs = {}
    for rel, rec in selected.items():
        path = f"{arch}/{rel}"
        entry = {"arch": arch, "package": rec["package"], "path": path, "type": rec["type"]}
        if rec["type"] == "file":
            entry["size"] = rec["size"]
            entry["sha256"] = rec["sha256"]
            entry["mode"] = format(rec["mode"], "04o")
            blobs[path] = rec["data"]
        else:
            entry["target"] = rec["target"]
        entries.append(entry)
    return entries, blobs


def doc_target_present(path, target, root):
    """True when the symlink chain resolves to a path that exists inside root."""
    current = path
    raw = target
    for _ in range(8):
        if os.path.isabs(raw):
            return False
        try:
            nxt = resolve_link(current.parent, raw, root)
        except ValueError:
            return False
        if nxt.is_symlink():
            raw = os.readlink(nxt)
            current = nxt
            continue
        return nxt.exists()
    return False


def doc_records(root, package, arch, upstream):
    """Describe share/doc/<package>. The files themselves are not archived."""
    usr = termux_usr(root)
    doc = usr / "share" / "doc" / package
    if not doc.is_dir():
        return []
    paths = []
    for current, dirnames, filenames in os.walk(doc, followlinks=False):
        current_path = Path(current)
        stay = []
        for name in dirnames:
            child = current_path / name
            if child.is_symlink():
                paths.append(child)
            else:
                stay.append(name)
        dirnames[:] = stay
        for name in filenames:
            paths.append(current_path / name)
    records = []
    for path in sorted(paths, key=lambda item: item.as_posix()):
        rel = path.relative_to(usr).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            records.append(
                {
                    "arch": arch,
                    "kind": "symlink",
                    "matches_upstream": False,
                    "path": rel,
                    "target": target,
                    "target_present": doc_target_present(path, target, root),
                }
            )
            continue
        data = path.read_bytes()
        kind = "placeholder" if data in PLACEHOLDER_BYTES else "file"
        records.append(
            {
                "arch": arch,
                "kind": kind,
                "matches_upstream": kind == "file" and data == upstream,
                "path": rel,
                "sha256": sha256_hex(data),
            }
        )
    return records


def license_readme():
    """One line per component, then the two provenance sentences."""
    lines = [
        f"{item['package']} {item['version']}, {item['spdx']}, {item['path']}, {item['url']}"
        for item in LICENSES
    ]
    lines.append("")
    lines.append(
        "The binaries are unmodified Termux builds whose provenance "
        "(deb url and sha256) is in MANIFEST.json."
    )
    lines.append(
        "The ICU and libc++ texts Termux shipped were replaced because they were wrong "
        "(ICU was a 404 placeholder and libc++ was labelled NCSA), and the OpenSSL and "
        "SQLite texts were replaced with the project's own licence files."
    )
    return "\n".join(lines) + "\n"


def abi_sort_key(name):
    """Sort by the path without its arch prefix, then the arch.

    The two copies of a library therefore sit next to each other.
    """
    _arch, _sep, rest = name.partition("/")
    return (rest, _arch)


def archive_members(manifest, blobs):
    """MANIFEST.json, then licences sorted, then both ABI trees sorted by abi_sort_key."""
    members = [
        {
            "name": "MANIFEST.json",
            "type": "file",
            "data": dump_manifest(manifest),
            "mode": 0o644,
        },
        {"name": "licenses", "type": "directory"},
    ]
    for name in sorted(path for path in blobs if path.startswith("licenses/")):
        members.append({"name": name, "type": "file", "data": blobs[name], "mode": 0o644})
    abi = []
    directories = set()
    for entry in manifest["files"]:
        path = entry["path"]
        parts = path.split("/")
        for index in range(2, len(parts)):
            directories.add("/".join(parts[:index]))
        if entry["type"] == "symlink":
            abi.append({"name": path, "type": "symlink", "target": entry["target"]})
        else:
            abi.append(
                {
                    "name": path,
                    "type": "file",
                    "data": blobs[path],
                    "mode": int(entry["mode"], 8),
                }
            )
    for name in directories:
        abi.append({"name": name, "type": "directory"})
    abi.sort(key=lambda member: abi_sort_key(member["name"]))
    return members + abi


def add_member(tar, member):
    """Append one TarInfo. The name is stored as given, so a test can include '..'."""
    info = tarfile.TarInfo(member["name"])
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    kind = member["type"]
    if kind == "directory":
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        return
    if kind == "file":
        data = member["data"]
        info.type = tarfile.REGTYPE
        info.mode = member["mode"]
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
        return
    if kind == "symlink":
        info.type = tarfile.SYMTYPE
        info.linkname = member["target"]
        info.mode = 0o777
        tar.addfile(info)
        return
    raise ValueError(f"unknown member type {kind}")


def render_tar_xz(members):
    """Deterministic GNU tar.xz bytes. mtime, uid and gid are 0."""
    blob = io.BytesIO()
    with tarfile.open(fileobj=blob, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for member in members:
            add_member(tar, member)
    return lzma.compress(
        blob.getvalue(),
        format=lzma.FORMAT_XZ,
        check=lzma.CHECK_CRC64,
        preset=9 | lzma.PRESET_EXTREME,
    )


def write_bytes_atomic(path, data):
    """Write data via a temp file in the same directory, then rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_tar_xz(path, members):
    """Write members to path as a deterministic GNU tar.xz. The write is atomic."""
    write_bytes_atomic(path, render_tar_xz(members))


def output_path(out, node_version):
    """Resolve --out. A *.tar.xz path is the file; anything else is the directory."""
    name = f"{ARCHIVE_PREFIX}{node_version}{ARCHIVE_SUFFIX}"
    path = Path(out)
    if path.name.endswith(".tar.xz"):
        if path.name != name:
            die(f"--out name must be {name}")
        return path
    return path / name


def classify(info):
    """Map a TarInfo to file, directory, symlink or other."""
    if info.issym():
        return "symlink"
    if info.isdir():
        return "directory"
    if info.isreg():
        return "file"
    return "other"


def decompress_xz(data):
    """Return (tar bytes or None, problem or None). Stop above MAX_TAR_BYTES of output."""
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
    parts = []
    total = 0
    offset = 0
    try:
        while not dec.eof:
            if dec.needs_input:
                if offset >= len(data):
                    raise lzma.LZMAError("compressed data ended before the end of the stream")
                end = offset + DECOMPRESS_CHUNK
                if end > len(data):
                    end = len(data)
                block = data[offset:end]
                offset = end
            else:
                block = b""
            # One extra byte shows that the stream continues past the cap.
            piece = dec.decompress(block, MAX_TAR_BYTES - total + 1)
            total += len(piece)
            over = total > MAX_TAR_BYTES
            filled = total == MAX_TAR_BYTES and not dec.eof and not dec.needs_input
            if over or filled:
                return None, f"decompressed archive is above {MAX_TAR_BYTES} bytes"
            parts.append(piece)
    except lzma.LZMAError as exc:
        return None, f"archive is not xz: {exc}"
    return b"".join(parts), None


def load_archive(path):
    """Return (manifest or None, members by name, problem lines). Reads one member at a time."""
    problems = []
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        return None, {}, [f"cannot read archive: {exc}"]
    if size > MAX_ARCHIVE_BYTES:
        return None, {}, [f"archive is {size} bytes, above {MAX_ARCHIVE_BYTES}"]
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        return None, {}, [f"cannot read archive: {exc}"]
    if len(raw) > MAX_ARCHIVE_BYTES:
        return None, {}, [f"archive is {len(raw)} bytes, above {MAX_ARCHIVE_BYTES}"]
    tar_bytes, problem = decompress_xz(raw)
    if problem:
        return None, {}, [problem]
    members = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as tar:
            count = 0
            for info in tar:
                count += 1
                if count > MAX_TAR_MEMBERS:
                    problems.append(f"archive has more than {MAX_TAR_MEMBERS} members")
                    break
                kind = classify(info)
                if info.size > MAX_MEMBER_BYTES:
                    problems.append(
                        f"archive member {info.name} is {info.size} bytes, "
                        f"above {MAX_MEMBER_BYTES}"
                    )
                    continue
                data = b""
                if kind == "file":
                    handle = tar.extractfile(info)
                    data = b"" if handle is None else handle.read(MAX_MEMBER_BYTES + 1)
                    if len(data) > MAX_MEMBER_BYTES:
                        problems.append(
                            f"archive member {info.name} is above {MAX_MEMBER_BYTES} bytes"
                        )
                        continue
                if info.name in members:
                    problems.append(f"duplicate archive member {info.name}")
                members[info.name] = {
                    "name": info.name,
                    "type": kind,
                    "data": data,
                    "target": info.linkname if kind == "symlink" else "",
                }
    except tarfile.TarError as exc:
        return None, {}, [f"archive is not a tar: {exc}"]
    info = members.get("MANIFEST.json")
    if info is None or info["type"] != "file":
        problems.append("archive has no MANIFEST.json")
        return None, members, problems
    try:
        manifest = json.loads(info["data"].decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        problems.append("MANIFEST.json is not JSON")
        return None, members, problems
    if not isinstance(manifest, dict):
        problems.append("MANIFEST.json is not an object")
        return None, members, problems
    return manifest, members, problems


def member_allowed(name):
    """True for MANIFEST.json, licences, and the two ABI usr trees."""
    if name == "MANIFEST.json":
        return True
    if name == "licenses" or name.startswith("licenses/"):
        return True
    for arch in ARCHES:
        prefix = f"{arch}/usr"
        if name == prefix or name.startswith(prefix + "/"):
            return True
    return False


def name_problems(name):
    """Absolute names, '..' components, and members outside the archive tree."""
    problems = []
    if name.startswith("/") or name.startswith("\\"):
        problems.append(f"archive member {name} is absolute")
    if any(part == ".." for part in name.split("/")):
        problems.append(f"archive member {name} contains '..'")
    if not member_allowed(name):
        problems.append(f"archive member {name} is outside the runtime archive")
    return problems


def symlink_target_escapes(member_name, target):
    """True when target is absolute or normalizes outside the link's directory."""
    if not isinstance(target, str) or target == "" or os.path.isabs(target):
        return True
    parent = posixpath.dirname(member_name)
    current = parent
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if current in ("", "."):
                return True
            current = posixpath.dirname(current)
            continue
        current = posixpath.join(current, part) if current else part
    if current != parent and not current.startswith(parent + "/"):
        return True
    return False


def canonical_path(path):
    """True when path has no empty, '.' or '..' segment and no trailing slash."""
    if not isinstance(path, str) or path == "" or path.endswith("/"):
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def lock_packages(lock_rows, arch):
    """Package names pinned for one arch."""
    found = set()
    for row in lock_rows:
        if isinstance(row, dict) and row.get("arch") == arch:
            found.add(row.get("package"))
    return found


def entry_path_problems(entry, lock_rows):
    """Arch, package and canonical-path problems for one manifest file entry."""
    path = entry.get("path")
    arch = entry.get("arch")
    problems = []
    if not isinstance(arch, str):
        problems.append(f"{path}: manifest entry has no arch")
        return problems
    parts = path.split("/") if isinstance(path, str) else []
    if not canonical_path(path):
        problems.append(f"{path} is not a canonical runtime path")
    if len(parts) < 3 or parts[0] != arch or parts[1] != "usr":
        problems.append(f"{path} is not under {arch}/usr/")
    if entry.get("package") not in lock_packages(lock_rows, arch):
        problems.append(f"{path} package {entry.get('package')} is not pinned for {arch}")
    return problems


def missing_staged_files(files, lock_rows, arch):
    """Require usr/bin/node and one regular file per stage_globs pattern for this arch."""
    problems = []
    regular = []
    node_path = f"{arch}/usr/bin/node"
    has_node = False
    prefix = f"{arch}/usr/"
    for entry in files:
        if not isinstance(entry, dict) or entry.get("arch") != arch or entry.get("type") != "file":
            continue
        path = entry.get("path")
        if path == node_path:
            has_node = True
        if isinstance(path, str) and path.startswith(prefix):
            regular.append(path[len(prefix) :])
    if not has_node:
        problems.append(f"{arch}: usr/bin/node is missing")
    for package in lock_packages(lock_rows, arch):
        patterns = GLOB_PATTERNS.get(package)
        if not patterns:
            continue
        for pattern in patterns:
            matched = False
            for rel in regular:
                if fnmatch.fnmatch(rel, pattern):
                    matched = True
                    break
            if not matched:
                problems.append(f"{arch}: {package} pattern {pattern} matched no regular file")
    return problems


def package_tuples(rows, arch):
    """(package, version, sha256, url) for one arch, in list order."""
    found = []
    for row in rows:
        if row.get("arch") != arch:
            continue
        found.append((row.get("package"), row.get("version"), row.get("sha256"), row.get("url")))
    return found


def check_archive(manifest, members, lock_rows, require_arches, require_licenses):
    """Problems that must refuse extract or verify. One string per problem."""
    problems = []
    if type(manifest.get("schema")) is not int or manifest.get("schema") != SCHEMA:
        problems.append(f"schema is not {SCHEMA}")
    node = manifest.get("node")
    major = node.split(".", 1)[0] if isinstance(node, str) else ""
    if major != NODE_MAJOR:
        problems.append(f"node major is not {NODE_MAJOR}")
    files = manifest.get("files")
    packages = manifest.get("packages")
    licenses = manifest.get("licenses")
    if not isinstance(files, list) or not isinstance(packages, list) or not isinstance(licenses, list):
        problems.append("manifest files, packages or licenses is not a list")
        return problems
    for arch in require_arches:
        if package_tuples(lock_rows, arch) != package_tuples(packages, arch):
            problems.append(f"{arch}: manifest packages differ from the lock")
    known_files = set()
    known_links = set()
    seen_paths = {}
    for entry in files:
        if not isinstance(entry, dict):
            problems.append("manifest file entry is not an object")
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            problems.append("manifest file entry has no path")
            continue
        problems.extend(entry_path_problems(entry, lock_rows))
        normal = posixpath.normpath(path)
        if normal in seen_paths:
            problems.append(f"{path} collides with {seen_paths[normal]}")
        else:
            seen_paths[normal] = path
        if entry.get("type") == "symlink":
            known_links.add(path)
        elif entry.get("type") == "file":
            known_files.add(path)
    for arch in require_arches:
        problems.extend(missing_staged_files(files, lock_rows, arch))
    known_licenses = set()
    for entry in licenses:
        if isinstance(entry, dict) and isinstance(entry.get("path"), str):
            known_licenses.add(entry["path"])
    for name, member in members.items():
        problems.extend(name_problems(name))
        if member["type"] == "directory":
            continue
        if member["type"] == "other":
            problems.append(f"archive member {name} is neither file, directory nor symlink")
            continue
        if member["type"] == "symlink":
            if symlink_target_escapes(name, member["target"]):
                problems.append(f"{name} symlink target escapes its directory")
            if name not in known_links:
                problems.append(f"archive member {name} is not in the manifest")
            continue
        if name in ("MANIFEST.json", "licenses/README.md"):
            continue
        if name not in known_files and name not in known_licenses:
            problems.append(f"archive member {name} is not in the manifest")
    for entry in files:
        if not isinstance(entry, dict):
            continue
        arch = entry.get("arch")
        path = entry.get("path")
        if not isinstance(path, str):
            continue
        member = members.get(path)
        if member is None:
            if arch in require_arches:
                problems.append(f"manifest entry {path} is missing from the archive")
            continue
        if entry.get("type") == "file":
            if member["type"] != "file":
                problems.append(f"{path} is not a file in the archive")
                continue
            have = sha256_hex(member["data"])
            want = entry.get("sha256")
            if have != want:
                problems.append(f"sha256 mismatch for {path}: expected {want} actual {have}")
            mode = entry.get("mode")
            if mode not in ("0755", "0644"):
                problems.append(f"{path} mode is not 0755 or 0644")
        elif entry.get("type") == "symlink":
            if member["type"] != "symlink":
                problems.append(f"{path} is not a symlink in the archive")
            elif member["target"] != entry.get("target"):
                problems.append(
                    f"{path} symlink target is {member['target']}, "
                    f"manifest says {entry.get('target')}"
                )
        else:
            problems.append(f"{path} type is not file or symlink")
    if require_licenses:
        for entry in licenses:
            if not isinstance(entry, dict):
                problems.append("manifest licence entry is not an object")
                continue
            path = entry.get("path")
            member = members.get(path) if isinstance(path, str) else None
            if member is None:
                problems.append(f"manifest licence {path} is missing from the archive")
                continue
            if member["type"] != "file":
                problems.append(f"{path} is not a file in the archive")
                continue
            have = sha256_hex(member["data"])
            want = entry.get("sha256")
            if have != want:
                problems.append(f"sha256 mismatch for {path}: expected {want} actual {have}")
    return problems


def write_file(path, data, mode):
    """Create path with O_EXCL and O_NOFOLLOW, then chmod past the umask."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written == 0:
                die(f"short write to {path}")
            view = view[written:]
    finally:
        os.close(fd)
    os.chmod(path, mode)


def mkdir_chain(root, rel):
    """Create directories under root. A symlink component is refused, not followed."""
    current = root
    if rel in ("", "."):
        return current
    for part in rel.split("/"):
        if part in ("", ".", ".."):
            die(f"refusing to extract {rel}")
        current = current / part
        if current.is_symlink():
            die(f"refusing to follow symlink {current}")
        if current.exists():
            if not current.is_dir():
                die(f"refusing to replace non-directory {current}")
            continue
        os.mkdir(current, 0o755)
    return current


def place_member(root, rel, entry, members):
    """Write one manifest entry under root. rel is usr/... inside the temp tree."""
    if not canonical_path(rel):
        die(f"refusing to extract {rel}")
    parent_rel = posixpath.dirname(rel)
    name = posixpath.basename(rel)
    parent = mkdir_chain(root, parent_rel)
    out = parent / name
    if out.is_symlink() or out.exists():
        die(f"refusing to replace {out}")
    if entry["type"] == "symlink":
        os.symlink(entry["target"], out)
        return
    write_file(out, members[entry["path"]]["data"], int(entry["mode"], 8))


def extract_tree(dest, arch, manifest, members):
    """Stage usr in a private temp dir, then rename it onto dest/usr.

    Member bytes are written only in that temp dir. Never uses tarfile.extractall.
    """
    dest = Path(dest)
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)
    final = dest / "usr"
    if os.path.lexists(final):
        die(f"refusing to replace {final}")
    dest.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(final):
        die(f"refusing to replace {final}")
    temp = Path(tempfile.mkdtemp(prefix=".levix-extract-", dir=parent))
    try:
        root = temp / "payload"
        os.mkdir(root, 0o755)
        prefix = arch + "/"
        for entry in manifest["files"]:
            if entry.get("arch") != arch:
                continue
            path = entry["path"]
            if not path.startswith(prefix):
                die(f"refusing to extract {path}")
            place_member(root, path[len(prefix) :], entry, members)
        staged = root / "usr"
        if staged.is_symlink() or not staged.is_dir():
            die(f"{arch}: extracted tree has no usr directory")
        if os.path.lexists(final):
            die(f"refusing to replace {final}")
        os.rename(staged, final)
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def count_entries(manifest, arches):
    """Return (regular files, symlinks) for the given arches."""
    files = [entry for entry in manifest["files"] if entry.get("arch") in arches]
    regular = sum(1 for entry in files if entry.get("type") == "file")
    links = sum(1 for entry in files if entry.get("type") == "symlink")
    return regular, links


def index_lock(rows):
    """Map (arch -> package -> row) and return problem lines for a build lock."""
    problems = []
    known = set(PACKAGES)
    by_arch = {arch: {} for arch in ARCHES}
    for row in rows:
        where = f"{row['arch']} {row['package']}"
        if row["arch"] not in by_arch:
            problems.append(f"{where}: arch is not aarch64 or arm")
            continue
        if row["package"] not in known:
            problems.append(f"{where}: package is not part of the runtime")
            continue
        if row["package"] in by_arch[row["arch"]]:
            problems.append(f"{where}: duplicate package")
            continue
        if re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is None:
            problems.append(f"{where}: sha256 is not 64 lowercase hex")
        if not row["url"].startswith("https://"):
            problems.append(f"{where}: url does not start with https://")
        by_arch[row["arch"]][row["package"]] = row
    for arch in ARCHES:
        for package in PACKAGES:
            if package not in by_arch[arch]:
                problems.append(f"missing {package} for {arch}")
    versions = {}
    for arch in ARCHES:
        row = by_arch[arch].get("nodejs-lts")
        if row is None:
            continue
        version = upstream_version(row["version"])
        if version.split(".", 1)[0] != NODE_MAJOR:
            problems.append(f"nodejs-lts {version} for {arch} is not Node {NODE_MAJOR}")
        versions[arch] = version
    if "aarch64" in versions and "arm" in versions and versions["aarch64"] != versions["arm"]:
        problems.append("aarch64 and arm pin different nodejs-lts versions")
    licensed = {item["package"] for item in LICENSES}
    if licensed != known:
        problems.append("LICENSES and PACKAGES disagree")
    for item in LICENSES:
        got = set()
        for arch in ARCHES:
            row = by_arch[arch].get(item["package"])
            if row is not None:
                got.add(upstream_version(row["version"]))
        if got != {item["version"]}:
            problems.append(
                f"{item['package']} version {sorted(got)} does not match licence {item['version']}"
            )
    node = versions.get("aarch64", "")
    return by_arch, node, problems


def stage_arch(deb_dir, arch_rows, arch, licence_data):
    """Extract one arch's debs and return (manifest file entries, blobs, doc records)."""
    root = Path(tempfile.mkdtemp(prefix=f"levix-node-{arch}-"))
    try:
        for row in arch_rows:
            extract_deb(deb_dir / url_basename(row["url"]), root)
        entries, blobs = select_runtime(root, arch, arch_rows)
        docs = {}
        for row in arch_rows:
            docs[row["package"]] = doc_records(
                root, row["package"], arch, licence_data[row["package"]]
            )
        return entries, blobs, docs
    finally:
        shutil.rmtree(root)


def cmd_build(args):
    """Build levix-node-runtime-<node>-android.tar.xz from the lock, debs and licences."""
    rows, problems = parse_lock(args.lock)
    finish(problems)
    _by_arch, node_version, problems = index_lock(rows)
    finish(problems)
    if not node_version:
        die("lock has no nodejs-lts version")
    licence_data = {}
    for item in LICENSES:
        name = posixpath.basename(item["path"])
        licence_data[item["package"]] = acquire(
            item["url"],
            Path(args.licenses) / name,
            item["sha256"],
            decode_base64=item.get("base64", False),
        )
    deb_dir = Path(args.debs)
    package_rows = []
    for row in rows:
        data = acquire(row["url"], deb_dir / url_basename(row["url"]), row["sha256"])
        package_rows.append(
            {
                "arch": row["arch"],
                "package": row["package"],
                "sha256": row["sha256"],
                "size": len(data),
                "url": row["url"],
                "version": row["version"],
            }
        )
    entries = []
    blobs = {}
    docs = {item["package"]: [] for item in LICENSES}
    for arch in ARCHES:
        arch_rows = [row for row in rows if row["arch"] == arch]
        arch_entries, arch_blobs, arch_docs = stage_arch(deb_dir, arch_rows, arch, licence_data)
        entries.extend(arch_entries)
        blobs.update(arch_blobs)
        for package, records in arch_docs.items():
            docs[package].extend(records)
    entries.sort(key=lambda entry: (entry["path"].split("/", 1)[1], entry["arch"]))
    for records in docs.values():
        records.sort(key=lambda record: (record["arch"], record["path"]))
    readme = license_readme().encode("utf-8")
    blobs["licenses/README.md"] = readme
    for item in LICENSES:
        blobs[item["path"]] = licence_data[item["package"]]
    licenses = []
    for item in LICENSES:
        data = licence_data[item["package"]]
        licenses.append(
            {
                "package": item["package"],
                "path": item["path"],
                "sha256": item["sha256"],
                "size": len(data),
                "spdx": item["spdx"],
                "termux_doc": docs[item["package"]],
                "url": item["url"],
                "version": item["version"],
            }
        )
    out = output_path(args.out, node_version)
    manifest = {
        "archive": out.name,
        "files": entries,
        "licenses": licenses,
        "node": node_version,
        "packages": package_rows,
        "schema": SCHEMA,
    }
    write_tar_xz(out, archive_members(manifest, blobs))
    written = out.read_bytes()
    print(f"{out} {len(written)} {sha256_hex(written)}")


def cmd_extract(args):
    """Check the archive, then extract one arch's usr tree into --dest."""
    rows, problems = parse_lock(args.lock)
    manifest, members, load_problems = load_archive(args.archive)
    problems.extend(load_problems)
    if manifest is not None:
        problems.extend(check_archive(manifest, members, rows, (args.arch,), True))
    finish(problems)
    extract_tree(args.dest, args.arch, manifest, members)
    regular, links = count_entries(manifest, (args.arch,))
    print(
        f"Runtime archive verified: {args.arch}, {regular} files, {links} symlinks, "
        f"Node {manifest['node']}"
    )


def cmd_verify(args):
    """Run the extract checks for both arches and the licence files. Extract nothing."""
    rows, problems = parse_lock(args.lock)
    manifest, members, load_problems = load_archive(args.archive)
    problems.extend(load_problems)
    if manifest is not None:
        problems.extend(check_archive(manifest, members, rows, ARCHES, True))
    finish(problems)
    regular, links = count_entries(manifest, ARCHES)
    print(
        f"Runtime archive verified: aarch64 and arm, {regular} files, {links} symlinks, "
        f"Node {manifest['node']}"
    )


def main(argv=None):
    """CLI: build, extract or verify."""
    parser = argparse.ArgumentParser(
        description="Build, extract and verify the Android Node runtime archive.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="Build the archive from pinned debs and upstream licences.")
    build.add_argument("--lock", required=True, help="Path to termux-packages.lock.")
    build.add_argument("--debs", required=True, help="Cache directory of .deb files, named by URL basename.")
    build.add_argument(
        "--licenses",
        required=True,
        help="Cache directory of upstream licence files, named by their archive basename.",
    )
    build.add_argument(
        "--out",
        required=True,
        help=(
            "Directory to write levix-node-runtime-<node>-android.tar.xz into, "
            "or that full file path. A path whose name ends in .tar.xz is the file; "
            "any other path is the directory."
        ),
    )
    extract = sub.add_parser("extract", help="Verify the archive and extract one arch.")
    extract.add_argument("--lock", required=True)
    extract.add_argument("--archive", required=True)
    extract.add_argument("--arch", required=True, choices=ARCHES)
    extract.add_argument("--dest", required=True, help="Directory that receives usr/.")
    verify = sub.add_parser("verify", help="Verify both arches and the licence files.")
    verify.add_argument("--lock", required=True)
    verify.add_argument("--archive", required=True)
    args = parser.parse_args(argv)
    if args.command == "build":
        cmd_build(args)
    elif args.command == "extract":
        cmd_extract(args)
    elif args.command == "verify":
        cmd_verify(args)
    else:
        die(f"unknown command {args.command}")


if __name__ == "__main__":
    main()
