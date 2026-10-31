// The runtime archive refuses a tampered member before it writes anything.
// The fixture is synthetic: node-runtime-archive.py's own tar helpers, no dpkg-deb.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const SCRIPT = join(ROOT, "android", "scripts", "node-runtime-archive.py");

const PROGRAM = `
import copy
import importlib.util
import sys
from pathlib import Path

script = sys.argv[1]
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("node_runtime_archive", script)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

def row(arch, package, version, label):
    digest = mod.sha256_hex(label.encode())
    url = "https://example.invalid/" + label + ".deb"
    return {
        "arch": arch,
        "package": package,
        "sha256": digest,
        "url": url,
        "version": version,
    }

def blob(text):
    data = text.encode()
    return data, mod.sha256_hex(data)

nodes = {}
libs = {}
pairs = (
    ("aarch64", "node-aarch64\\n", "lib-aarch64\\n"),
    ("arm", "node-arm\\n", "lib-arm\\n"),
)
for arch, node_text, lib_text in pairs:
    nodes[arch] = blob(node_text)
    libs[arch] = blob(lib_text)

license_text = b"zlib licence\\n"
license_sha = mod.sha256_hex(license_text)
rows = []
for arch in ("aarch64", "arm"):
    rows.append(row(arch, "nodejs-lts", "24.22.1", "nodejs-lts-" + arch))
    rows.append(row(arch, "zlib", "1.3.2", "zlib-" + arch))

lock_lines = []
for item in rows:
    lock_lines.append(
        " ".join(
            [item["arch"], item["package"], item["version"], item["sha256"], item["url"]]
        )
    )
(root / "lock").write_text("\\n".join(lock_lines) + "\\n", encoding="utf-8")

def file_entry(arch, rel, package, data, digest, mode):
    return {
        "arch": arch,
        "mode": mode,
        "package": package,
        "path": arch + "/" + rel,
        "sha256": digest,
        "size": len(data),
        "type": "file",
    }

def link_entry(arch, rel, package, target):
    return {
        "arch": arch,
        "package": package,
        "path": arch + "/" + rel,
        "target": target,
        "type": "symlink",
    }

files = []
for arch in ("aarch64", "arm"):
    node_data, node_sha = nodes[arch]
    lib_data, lib_sha = libs[arch]
    files.append(file_entry(arch, "usr/bin/node", "nodejs-lts", node_data, node_sha, "0755"))
    files.append(file_entry(arch, "usr/lib/libz.so.1", "zlib", lib_data, lib_sha, "0644"))
    files.append(link_entry(arch, "usr/lib/libz.so", "zlib", "libz.so.1"))

packages = []
for item in rows:
    packages.append(
        {
            "arch": item["arch"],
            "package": item["package"],
            "sha256": item["sha256"],
            "size": 1,
            "url": item["url"],
            "version": item["version"],
        }
    )

manifest = {
    "archive": "fixture.tar.xz",
    "files": files,
    "licenses": [
        {
            "package": "zlib",
            "path": "licenses/zlib-1.3.2-LICENSE",
            "sha256": license_sha,
            "size": len(license_text),
            "spdx": "Zlib",
            "termux_doc": [],
            "url": "https://example.invalid/zlib-LICENSE",
            "version": "1.3.2",
        }
    ],
    "node": "24.22.1",
    "packages": packages,
    "schema": 1,
}

def pack(path, manifest_obj, mutate=None, extra=None, drop=None, blobs_override=None):
    extra = extra or []
    drop = drop or set()
    blobs = {"licenses/zlib-1.3.2-LICENSE": license_text}
    for arch in ("aarch64", "arm"):
        blobs[arch + "/usr/bin/node"] = nodes[arch][0]
        blobs[arch + "/usr/lib/libz.so.1"] = libs[arch][0]
    if blobs_override:
        for key, value in blobs_override.items():
            blobs[key] = value
    if mutate is not None:
        mutate(blobs)
    members = [
        {
            "data": mod.dump_manifest(manifest_obj),
            "mode": 0o644,
            "name": "MANIFEST.json",
            "type": "file",
        },
        {"name": "licenses", "type": "directory"},
        {
            "data": blobs["licenses/zlib-1.3.2-LICENSE"],
            "mode": 0o644,
            "name": "licenses/zlib-1.3.2-LICENSE",
            "type": "file",
        },
    ]
    directories = set()
    for entry in manifest_obj["files"]:
        parts = entry["path"].split("/")
        for index in range(2, len(parts)):
            directories.add("/".join(parts[:index]))
    for name in sorted(directories):
        members.append({"name": name, "type": "directory"})
    for entry in manifest_obj["files"]:
        if entry["path"] in drop:
            continue
        if entry["type"] == "symlink":
            members.append(
                {"name": entry["path"], "target": entry["target"], "type": "symlink"}
            )
        else:
            members.append(
                {
                    "data": blobs[entry["path"]],
                    "mode": int(entry["mode"], 8),
                    "name": entry["path"],
                    "type": "file",
                }
            )
    members.extend(extra)
    mod.write_tar_xz(path, members)

def tamper(blobs):
    blobs["aarch64/usr/bin/node"] = b"tampered\\n"

pack(root / "good.tar.xz", manifest)
pack(root / "bad-bytes.tar.xz", manifest, mutate=tamper)
pack(
    root / "bad-escape.tar.xz",
    manifest,
    extra=[{"data": b"nope\\n", "mode": 0o644, "name": "../escape", "type": "file"}],
)
abs_name = str(root / "abs-member")
(root / "abs-path.txt").write_text(abs_name + "\\n", encoding="utf-8")
pack(
    root / "bad-absolute.tar.xz",
    manifest,
    extra=[{"data": b"nope\\n", "mode": 0o644, "name": abs_name, "type": "file"}],
)
linked = copy.deepcopy(manifest)
for entry in linked["files"]:
    if entry["path"] == "aarch64/usr/lib/libz.so":
        entry["target"] = "../../outside"
pack(root / "bad-symlink.tar.xz", linked)
newer = copy.deepcopy(manifest)
newer["node"] = "26.1.0"
pack(root / "bad-node.tar.xz", newer)
shifted = copy.deepcopy(manifest)
for entry in shifted["packages"]:
    if entry["arch"] == "aarch64" and entry["package"] == "nodejs-lts":
        entry["version"] = "24.22.0"
pack(root / "bad-packages.tar.xz", shifted)
pack(root / "bad-missing.tar.xz", manifest, drop={"aarch64/usr/lib/libz.so.1"})
stripped = copy.deepcopy(manifest)
stripped["files"] = [
    entry
    for entry in stripped["files"]
    if entry["path"] != "aarch64/usr/lib/libz.so.1"
]
pack(root / "bad-stripped.tar.xz", stripped)
crossed = copy.deepcopy(manifest)
crossed_bytes = b"crossed\\n"
crossed["files"].append(
    {
        "arch": "aarch64",
        "mode": "0644",
        "package": "zlib",
        "path": "arm/usr/lib/crossed.so",
        "sha256": mod.sha256_hex(crossed_bytes),
        "size": len(crossed_bytes),
        "type": "file",
    }
)
pack(
    root / "bad-arch-path.tar.xz",
    crossed,
    blobs_override={"arm/usr/lib/crossed.so": crossed_bytes},
)
member_limit = mod.MAX_MEMBER_BYTES
tar_limit = mod.MAX_TAR_BYTES
mod.MAX_MEMBER_BYTES = 4
_manifest, _members, member_problems = mod.load_archive(root / "good.tar.xz")
mod.MAX_MEMBER_BYTES = member_limit
(root / "limit-member.txt").write_text("\\n".join(member_problems), encoding="utf-8")
mod.MAX_TAR_BYTES = 8
_manifest, _members, tar_problems = mod.load_archive(root / "good.tar.xz")
mod.MAX_TAR_BYTES = tar_limit
(root / "limit-tar.txt").write_text("\\n".join(tar_problems), encoding="utf-8")
if not member_problems or not tar_problems:
    raise SystemExit("limit checks did not refuse")
`;

section("runtime archive extract and verify");

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (python.status !== 0) {
  console.log("    (python3 not on PATH — skipping the runtime archive cases)");
} else {
  const root = mkdtempSync(join(tmpdir(), "levix-runtime-archive-"));
  try {
    const built = spawnSync("python3", ["-B", "-c", PROGRAM, SCRIPT, root], { encoding: "utf8" });
    ok("the fixture builder exits 0", built.status === 0, built.stderr);
    if (built.status === 0) {
      const memberLimit = readFileSync(join(root, "limit-member.txt"), "utf8");
      const tarLimit = readFileSync(join(root, "limit-tar.txt"), "utf8");
      ok("a member above the lowered limit is refused", memberLimit.includes("above"));
      ok("decompressed output above the lowered limit is refused", tarLimit.includes("above"));
      const lock = join(root, "lock");
      const good = join(root, "good.tar.xz");
      const cli = (args) => spawnSync("python3", ["-B", SCRIPT, ...args], { encoding: "utf8" });
      const before = readdirSync(root).sort().join("\n");
      const verified = cli(["verify", "--lock", lock, "--archive", good]);
      ok("verify exits 0", verified.status === 0, verified.stderr);
      ok(
        "verify names both arches and Node 24.22.1",
        verified.stdout.includes(
          "Runtime archive verified: aarch64 and arm, 4 files, 2 symlinks, Node 24.22.1",
        ),
      );
      equal("verify extracts nothing", readdirSync(root).sort().join("\n"), before);

      function checkTree(arch, nodeText, libText) {
        const dest = join(root, `out-${arch}`);
        const run = cli([
          "extract",
          "--lock",
          lock,
          "--archive",
          good,
          "--arch",
          arch,
          "--dest",
          dest,
        ]);
        ok(`${arch} extract exits 0`, run.status === 0, run.stderr);
        ok(
          `${arch} extract names Node 24.22.1`,
          run.stdout.includes(
            `Runtime archive verified: ${arch}, 2 files, 1 symlinks, Node 24.22.1`,
          ),
        );
        const nodePath = join(dest, "usr", "bin", "node");
        const libPath = join(dest, "usr", "lib", "libz.so.1");
        const linkPath = join(dest, "usr", "lib", "libz.so");
        ok(`${arch} node bytes`, readFileSync(nodePath).equals(Buffer.from(nodeText)));
        ok(`${arch} lib bytes`, readFileSync(libPath).equals(Buffer.from(libText)));
        equal(`${arch} node mode`, lstatSync(nodePath).mode & 0o777, 0o755);
        equal(`${arch} lib mode`, lstatSync(libPath).mode & 0o777, 0o644);
        equal(`${arch} libz.so target`, readlinkSync(linkPath), "libz.so.1");
      }

      checkTree("aarch64", "node-aarch64\n", "lib-aarch64\n");
      checkTree("arm", "node-arm\n", "lib-arm\n");

      const badCases = [
        ["bad-bytes", "bad-bytes.tar.xz"],
        ["bad-escape", "bad-escape.tar.xz"],
        ["bad-absolute", "bad-absolute.tar.xz"],
        ["bad-symlink", "bad-symlink.tar.xz"],
        ["bad-node", "bad-node.tar.xz"],
        ["bad-packages", "bad-packages.tar.xz"],
        ["bad-missing", "bad-missing.tar.xz"],
        ["bad-stripped", "bad-stripped.tar.xz"],
        ["bad-arch-path", "bad-arch-path.tar.xz"],
      ];
      for (const [label, file] of badCases) {
        const parent = join(root, `parent-${label}`);
        mkdirSync(parent);
        const dest = join(parent, "dest");
        const archive = join(root, file);
        const rejected = cli(["verify", "--lock", lock, "--archive", archive]);
        ok(`${label} verify exits 1`, rejected.status === 1, rejected.stderr);
        const extracted = spawnSync(
          "python3",
          [
            "-B",
            SCRIPT,
            "extract",
            "--lock",
            lock,
            "--archive",
            archive,
            "--arch",
            "aarch64",
            "--dest",
            dest,
          ],
          { cwd: parent, encoding: "utf8" },
        );
        ok(`${label} extract exits 1`, extracted.status === 1, extracted.stderr);
        equal(`${label} leaves nothing outside dest`, readdirSync(parent).join(" "), "");
        ok(`${label} does not create dest`, !existsSync(dest));
      }
      const absPath = readFileSync(join(root, "abs-path.txt"), "utf8").trim();
      ok("the absolute member was not created", absPath.length > 0 && !existsSync(absPath));
      ok("the escape member was not created", !existsSync(join(root, "escape")));
      const occupied = join(root, "occupied");
      mkdirSync(join(occupied, "usr"), { recursive: true });
      writeFileSync(join(occupied, "usr", "keep"), "stay\n");
      const occupiedRun = cli([
        "extract",
        "--lock",
        lock,
        "--archive",
        good,
        "--arch",
        "aarch64",
        "--dest",
        occupied,
      ]);
      ok("existing dest/usr is refused", occupiedRun.status === 1, occupiedRun.stderr);
      equal("existing usr is unchanged", readdirSync(join(occupied, "usr")).join(" "), "keep");
      ok(
        "the kept file is unchanged",
        readFileSync(join(occupied, "usr", "keep")).equals(Buffer.from("stay\n")),
      );
      const leftovers = readdirSync(root).filter((name) => name.startsWith(".levix-extract-"));
      equal("the extract temp dir is removed", leftovers.join(" "), "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

finish();
