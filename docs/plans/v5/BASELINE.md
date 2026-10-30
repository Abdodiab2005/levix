# Levix v5.0.0 baseline (Phase 00)

Status: measured on 2026-10-30. Every number below comes from a command run on that date or from a
named artifact. Nothing here is an estimate unless a line says INFERENCE.

## 1. Source state

| Item | Value | Evidence |
| --- | --- | --- |
| Base commit | `050d8b9` (`chore(release): bump version to 4.9.2`) | `git log -1` |
| Tag at base | `v4.9.2` | `git describe --tags` |
| Working tree before Phase 00 | clean, branch `main` | `git status` |
| Open pull requests | none | `gh pr list --state open` |
| Last merged PR | #79 (dependabot npm minor/patch group, 2026-10-26) | `gh pr list --state all` |
| Branches not merged into `main` | 1: `zcode/commands-panel-upgrades` (2 commits, 2026-09-30, settings export/import inside the Android WebView) | `git branch --no-merged main`, `git cherry main zcode/commands-panel-upgrades` |
| CI on base commit | run 40467429633: 7 of 7 jobs `success` (tests, package, SEA on 3 OSes, Docker, Android APK build with `:app:testDebugUnitTest`) | `gh run view 40467429633` |
| Release workflow on base commit | run 40467429376 (`v4.9.2`) `success` | `gh run list --workflow release.yml` |

The unmerged branch touches the same settings export and import paths that Phase 02 (Backup and
Restore) will touch. Phase 02 must decide whether its two commits are superseded before it starts.

## 2. Environment used for this baseline

| Item | Value |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS, Linux 7.0.0-38-generic, x86_64 |
| CPU and memory | 8 logical CPUs, 7 GiB RAM |
| Node.js | v24.19.0 (standalone binary without a bundled npm) |
| npm | 9.2.0 (`/usr/bin/npm`, the distribution package). CI uses the npm bundled with `setup-node` Node 24, so local install behaviour can differ from CI. |
| Java | OpenJDK 17.0.21 on `PATH` |
| Android runtime cache | absent (`~/.cache/levix-android` does not exist), Android NDK r29 not installed |

Six read-only audit agents ran on the same machine during `npm test`. Wall-clock times below are
therefore upper bounds, not clean benchmarks.

## 3. Gate results

| Gate | Result | Wall time | Evidence |
| --- | --- | --- | --- |
| `npm ci` | PASS (exit 0), 283 packages added | 35.8 s | local log |
| `npm --prefix frontend ci` | PASS (exit 0), 130 packages added | 4.7 s | local log |
| `npm test` | PASS (exit 0): 68 test files, 5039 checks, 0 failed, 0 crashed | 14 min 36 s (CPU: 63 s user, 9.9 s system) | started 13:41:06Z, ended 13:55:42Z |
| `npm run lint` | PASS (exit 0): 368 files, 0 errors, 174 warnings, 61 infos | 0.75 s | local log |
| `npm run build:frontend` | PASS (exit 0) | 7.4 s | local log |
| Android `:app:testDebugUnitTest` | BLOCKED locally. Gradle checks the staged Termux runtime at configuration time (`android/app/build.gradle.kts:51`), and no runtime is staged on this machine. Staging needs `android/scripts/fetch-node-android.sh`, which downloads Termux packages and builds FFmpeg with NDK r29. CI ran the task on the base commit with result `success`. | n/a | `gh run view 40467429633` |
| `npm run validate:tarball`, `validate:sea`, `validate:docker` | NOT RUN locally (outside Phase 00). CI ran all three on the base commit with result `success`. | n/a | same CI run |

### Test-suite timing observation

`tests/reply-language.test.mjs` ran its English sweep for about 11 minutes at 0.1% CPU (log
timestamps 15:42:57 to 15:54:12 local time). The same commit's CI `tests` job finished the whole
suite in 4 min 35 s. Two isolated re-runs of that file (section 7) took 102 s and 105 s and made no
network connection.

### Dependency audit (`npm audit`, 2026-10-30)

| Tree | Total | Severity | Packages (all transitive, fix available) |
| --- | --- | --- | --- |
| root, production dependencies | 7 | 3 high, 4 moderate | high: `body-parser`, `engine.io`, `follow-redirects`; moderate: `fast-copy`, `ip-address`, `music-metadata`, `qs` |
| `frontend/` | 2 | 2 high | `vite` (direct, dev server only), `source-map-js` |

The frontend findings concern the Vite dev server and build tooling. The built static bundle in
`public/dashboard/` does not include the dev server. The root findings are runtime dependencies and
belong to Phase 01's supply-chain review.

## 4. Frontend build output

| File | Bytes | gzip |
| --- | --- | --- |
| `public/dashboard/assets/index-*.js` | 788.83 kB | 235.22 kB |
| `public/dashboard/assets/index-*.css` | 87.07 kB | 11.99 kB |
| `public/dashboard/index.html` | 1.04 kB | 0.51 kB |
| Total `public/dashboard/` | 876,941 bytes in 3 files | |

Vite warns that one chunk exceeds 500 kB after minification.

## 5. Release artifact sizes (GitHub Releases API)

| Asset | v4.9.1 (2026-10-26) | v4.9.2 (2026-10-27) | Delta |
| --- | --- | --- | --- |
| `levix-android-arm64.apk` | 88,380,740 | 94,439,912 | +6,059,172 |
| `levix-android-armv7.apk` | 83,722,774 | 89,781,950 | +6,059,176 |
| `levix-android.aab` | 116,748,361 | 122,807,543 | +6,059,182 |
| `levix-linux-x64` | 145,099,968 | 145,099,968 | 0 |
| `levix-macos-arm64` | 139,681,856 | 139,698,272 | +16,416 |
| `levix-windows-x64.exe` | 112,502,272 | 112,521,728 | +19,456 |

Source: `gh release view <tag> --json assets`. These are file sizes. They are not Google Play
download sizes and not Play update (delta) sizes; neither was measured.

## 6. Composition of the official v4.9.1 arm64 APK

Artifact: `levix-android-arm64.apk`, sha256 `f6949d9c7679b8d155a5cbf2ada40814756b3ddd1d74428e29620bdd82b75f4e`,
which matches the v4.9.1 `SHA256SUMS.txt` on GitHub. Listed with `unzip -lv`; native libraries read
with `readelf -d`. The v4.9.2 APK was not downloaded, so its composition is not measured.

| Component | Entries | Stored bytes | Share of stored total | Uncompressed bytes |
| --- | --- | --- | --- | --- |
| `lib/arm64-v8a/*.so` | 13 | 39,816,124 | 45.1% | 118,543,483 |
| `assets/levix-app.zip` | 1 | 37,019,287 | 41.9% | 38,108,849 |
| `classes.dex` (stored, not compressed) | 1 | 9,709,524 | 11.0% | 9,709,524 |
| `resources.arsc` | 1 | 1,139,516 | 1.3% | 1,139,516 |
| `res/` | 869 | 550,332 | 0.6% | 1,162,717 |
| everything else | 67 | 23,447 | 0.03% | 60,515 |
| Total | 952 | 88,258,230 | 100% | 168,724,604 |

Largest native libraries (stored / uncompressed bytes): `libnode.so` 15,116,521 / 56,684,969;
`libicudata_78.so` 12,798,498 / 33,161,385; `libffmpeg.so` 4,425,963 / 8,778,208;
`libcrypto_3.so` 2,388,909 / 5,369,073; `libicui18n_78.so` 1,254,774 / 5,061,009.

Facts from the native libraries:

- `libnode.so` contains the version string `v24.22.1` (Termux package `nodejs-lts`).
- `libnode.so` needs `libsqlite3.so`. No library in the APK lists `libsqlite3_3.53.4.so` or
  `libsqlite3_3.54.0.so` as `NEEDED`, yet both ship (671,127 and 677,734 stored bytes). A runtime
  `dlopen` of either file is NOT VERIFIED either way.
- The native libraries are compressed inside the APK (`useLegacyPackaging = true`,
  `android/app/build.gradle.kts:140`), so Android extracts them at install time.

### Inside `assets/levix-app.zip` (v4.9.1)

5,390 entries, 119,838,992 bytes uncompressed, 36,934,593 bytes compressed.

| Entry group | Compressed bytes | Uncompressed bytes | Dependency type (`package-lock.json`) |
| --- | --- | --- | --- |
| `node_modules/@biomejs/cli-linux-x64` | 24,336,010 | 66,663,064 | dev, an x86_64 Linux linter binary |
| `node_modules/@google/genai` | 1,446,314 | 9,188,288 | production |
| `node_modules/postject` | 1,412,794 | 4,868,071 | dev |
| `node_modules/@whiskeysockets/baileys` | 1,181,123 | 8,111,466 | production |
| `node_modules/whatsapp-rust-bridge` | 843,619 | 2,040,511 | production |
| `public/` | 575,421 | 1,372,748 | app |
| `src/` | 461,653 | 1,424,559 | app |
| `node_modules/@types/node` | 458,885 | 2,379,575 | production (transitive, through `protobufjs`) |
| `node_modules/@biomejs/biome` | 122,062 | 782,006 | dev |

Dev-only packages in the shipped zip: 25,870,866 compressed bytes, 70.0% of the zip. Cause:
`android/scripts/stage-levix-app.sh:65` copies the whole `node_modules/` after a full `npm ci` and
excludes only `ffmpeg-static`, `esbuild`, `@esbuild`, `@img` and `sharp`. The Docker image already
installs with `npm ci --omit=dev` (`Dockerfile:10`).

### The v4.9.2 growth

All three Android artifacts grew by about 6,059,180 bytes between v4.9.1 and v4.9.2. The same release
bumped `@biomejs/biome` from 2.5.15 to 2.6.2 (`git diff v4.9.1 v4.9.2 -- package-lock.json`). The
2.6.2 `@biomejs/cli-linux-x64` package on this machine is 84,146,556 bytes, and its `biome` binary
gzips to 30,409,653 bytes. That is 6,073,643 bytes more than the 2.5.15 entry above.
INFERENCE: the growth is the larger linter binary inside `levix-app.zip`. Phase 01 confirms it by
listing the v4.9.2 artifact.

## 7. Offline test experiment

Command: `unshare -rn node tests/run.mjs reply-language` (a network namespace with no usable
interface). Result: PASS, 41 checks, 0 failed, 104.8 s wall time.

A second run with the network present, traced with `strace -f -e trace=connect`, recorded 0
`connect()` calls and passed in 102.2 s. So the file makes no network connection and does not need
one. The 11-minute stall inside the full `npm test` run is therefore not a network wait. Its cause is
NOT IDENTIFIED. That run shared a 7 GiB machine with six agent processes, and CI ran the whole suite
in 4 min 35 s on the same commit. Phase 01 re-times the suite on an idle machine before it sets any
test-time budget.

## 8. Node.js release facts on 2026-10-30

| Source | Fact |
| --- | --- |
| `https://nodejs.org/dist/index.json` | latest v24 is `v24.22.2` (2026-10-27, LTS "Krypton"); latest v26 is `v26.13.0` (2026-10-28) and is already LTS ("Lithium") |
| Termux `stable` index, `binary-aarch64` and `binary-arm` | `nodejs-lts` is `24.22.1`; `nodejs` is `26.12.1` |
| `android/scripts/fetch-node-android.sh:34` | fetches `nodejs-lts` by name, with no version pin and no sha256 check of the `.deb` files |

Node 26 is now an LTS line. When Termux moves `nodejs-lts` to 26.x, the next Android build switches
Node major without any code change. This is risk R-01 in `RISKS.md`.

## 9. Measurement plan for Phase 01

Phase 01 must produce the same tables for v4.9.2 and for its own output, per ABI, from artifacts and
not from estimates:

1. For every APK and the AAB: `unzip -lv`, grouped as in section 6; `apkanalyzer apk file-size`
   and `apkanalyzer files list` when the SDK command-line tools are present; `bundletool
   build-apks --mode=default` plus `get-size total` for the AAB per device spec.
2. For every native library: stored and uncompressed bytes, `readelf -d` (`NEEDED`, `SONAME`),
   `readelf -lW` page alignment for the 16 KB rule, and the Node version string in `libnode.so`.
3. For `levix-app.zip`: entry count, compressed and uncompressed bytes, grouped by top-level path and
   by npm package, each package tagged dev or production from `package-lock.json`.
4. For `classes.dex` and resources: size before and after any R8 or resource-shrinking experiment.
5. Runtime numbers on a named test device: cold start to panel-ready time, peak RSS of the Node
   process, and idle CPU, each with the exact procedure written next to the number.
6. Google Play download and update sizes only from Play Console or `bundletool` output, labelled
   with their source. Without that source they stay NOT MEASURED.
