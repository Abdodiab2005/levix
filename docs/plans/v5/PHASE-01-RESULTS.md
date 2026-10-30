# Levix v5.0.0 Phase 01 results: code, build and performance

Status: IN PROGRESS (PR 01a open for review). Phase 01 started on 2026-10-30 after the owner approved and merged Phase 00
(PRs #80, #81 and #83; PR #82 is postponed by the owner and is not part of this phase's work).
Every number in this file comes from a command or an artifact named next to it. A number that was
not measured says NOT MEASURED.

## 1. Starting point

| Item | Value | Evidence |
| --- | --- | --- |
| Base commit | `52d6949` (merge of PR #83) | `git log -1 origin/main` |
| Post-merge CI | run 41083432588, 7 of 7 jobs `success` | `gh run view 41083432588` |
| Local Node used for gates | official v24.22.2 linux-x64 (npm 11.19.1), tarball checked against the release `SHASUMS256.txt` | `node -v`, `sha256sum -c` |
| Android device for smoke tests | none attached (`adb devices` lists nothing) | local |
| Local Android SDK | platform-tools only; no NDK, platform or build-tools | `ls $ANDROID_HOME` |

Android builds in this phase therefore run in CI. Device smoke stays NOT RUN until a device and a
dedicated test account are available with the owner's authorization.

## 2. Re-audit findings (2026-10-30)

| ID | Finding | Evidence | Handled in |
| --- | --- | --- | --- |
| P1-01 | Termux `nodejs-lts` is still 24.22.1 for `aarch64` and `arm`; Termux `nodejs` is 26.12.1. The newest Node 24 is v24.22.2 (2026-10-27); v24.22.1 (2026-10-20) is the security release. | Termux `binary-aarch64` and `binary-arm` `Packages` indexes; `nodejs.org/dist/index.json` | 01a |
| P1-02 | Termux serves only the newest file of each package. `nodejs-lts_24.22.0_aarch64.deb` and `nodejs-lts_24.21.0_aarch64.deb` answer HTTP 404; `24.22.1` answers 200. A pinned file stops downloading as soon as Termux updates that package. | `curl -I` on the three pool URLs | 01a, Q-23 |
| P1-03 | The fetch script extracts every cached `.deb` (`for deb in "$WORKDIR/debs"/*.deb`), and CI restores older caches through `restore-keys`. Old and new files overwrite each other in alphabetical order. Termux `libsqlite3.so.3.x` has no `SONAME`, so each stale copy is staged under its own versioned name. This is the cause of the two unused `libsqlite3_3.53.4.so` and `libsqlite3_3.54.0.so` in the v4.9.1 APK. | `android/scripts/fetch-node-android.sh:279`, `.github/workflows/ci.yml:128`, `readelf -d libsqlite3.so.3.54.1` (no `SONAME`), `dpkg-deb -c libsqlite_3.54.1_aarch64.deb` | 01a |
| P1-04 | Node's `process.version` string sits in the Termux binary as the NUL-delimited C string `\0v24.22.1\0`, once. A packaging check can read it without running the ARM binary. | byte search of `nodejs-lts_24.22.1_aarch64.deb` `bin/node` | 01a |
| P1-05 | Every `actions/setup-node` step asks for `node-version: 24`, which resolves to whatever 24.x is newest when the job runs. The release jobs `verify-version` and `installer` run the runner's own Node. The Docker image uses the floating `node:24-slim` tag. | `.github/workflows/*.yml`, `Dockerfile` | 01a |
| P1-06 | The SEA build copies `process.execPath`, so an executable ships exactly the Node that built it. Nothing stops a Node 26 host from building one. | `scripts/build-sea.mjs:282` | 01a |
| P1-07 | `deploy/install.sh` prints "good" for any Node from 24 up. | `deploy/install.sh:158` | 01a |
| P1-08 | `stage-levix-app.sh` copies the repository's full `node_modules` (dev dependencies included) and zips it with `zip -qr`, which records file times and directory order. The archive is not reproducible. | `android/scripts/stage-levix-app.sh:65`, `:89` | 01b |
| P1-09 | Five packages have install scripts: `@google/genai` (a no-op `echo`), `@whiskeysockets/baileys` (an engine check), `protobufjs` (a version check), `ffmpeg-static` (downloads a host FFmpeg) and `esbuild` (dev). None of them produces a file that Levix uses on Android. | `package-lock.json` `hasInstallScript`, each package's `scripts` | 01b |
| P1-10 | All 102.9 s of `tests/reply-language.test.mjs` is spent in one place: `sendBotMessage()` sleeps a typing delay of 400 to 2,500 ms per reply (58 calls). The test sets `bot_min_delay_ms` and `bot_max_delay_ms` to 0, but the typing delay ignores both settings. | `--require` timer probe summing `setTimeout` per call site, `src/utils/sendBotMessage.esm.js:39`, `:86` | 01e |
| P1-11 | `npm audit --omit=dev`: 7 advisories (3 high: `body-parser`, `engine.io`, `follow-redirects`; 4 moderate: `fast-copy`, `ip-address`, `music-metadata`, `qs`), all transitive, all fixable without `--force`. `frontend/`: 2 high (`vite`, `source-map-js`), both build tooling, fixable without `--force`. | `npm audit --json` with npm 11.19.1 | 01c |

### v4.9.2 Android artifacts (the "before" for every size table)

Downloaded with `gh release download v4.9.2`; all three match the release `SHA256SUMS.txt`. Grouped
from the zip central directory (stored bytes are the bytes inside the APK or AAB).

| Component | arm64 APK | armv7 APK | AAB |
| --- | --- | --- | --- |
| `assets/levix-app.zip` | 43,078,460 | 43,078,460 | 43,078,460 |
| native libraries (13 per ABI) | 39,816,124 | 35,158,107 | 74,974,231 (both ABIs) |
| dex | 9,709,524 (stored) | 9,709,524 (stored) | 3,536,572 (deflated) |
| resource table and `res/` | 1,689,848 | 1,689,848 | 925,188 |
| other | 23,447 | 23,447 | 118,744 |
| Total stored | 94,317,403 | 89,659,386 | 122,633,195 |
| File size | 94,439,912 | 89,781,950 | 122,807,543 |

- `levix-app.zip`: 5,393 entries, 43,042,233 compressed bytes. Dev-only packages take 32,008,227
  bytes, 74.4% of it. `@biomejs/cli-linux-x64` alone is 30,410,076 bytes. This confirms the
  Phase 00 inference: v4.9.2 grew because the Biome binary grew.
- Both ABIs still ship the two unused `libsqlite3_3.53.4.so` and `libsqlite3_3.54.0.so`: 1,348,861
  stored bytes on arm64 and 1,118,578 on armv7 (P1-03).
- Every `libnode.so` carries `v24.22.1`.
- `bundletool 1.18.3 get-size total --dimensions=ABI` on the AAB (an estimate by bundletool, not a
  Play Console number): arm64-v8a 86,716,771 to 86,739,273 bytes, armeabi-v7a 82,084,520 to
  82,107,022 bytes. Play update (delta) sizes: NOT MEASURED.

## 3. Plan

Each workstream is one pull request. 01a goes first. 01b builds on 01a's branch because both change
the Android scripts and the CI cache key. 01c and 01e branch from `main`. 01d builds on 01b, because
it needs 01b's size report to measure anything.

### PR 01a: Node.js 24 policy and pinned runtimes

- Desktop pin: `.node-version` holds `24.22.2`. Every `setup-node` step reads it
  (`node-version-file`), including `verify-version` and `installer`. The Dockerfile takes the same
  version as `ARG NODE_VERSION`. A test keeps all of them equal.
- Android pin: `android/scripts/termux-packages.lock` lists the 7 Termux packages per ABI with
  version, sha256 and URL. The fetch script downloads exactly those files, checks each sha256,
  deletes any other cached `.deb`, extracts only the pinned files, and fails unless `libnode.so`
  carries `\0v24.22.1\0`. `--update-pins` refreshes the lock and refuses a `nodejs-lts` that is not
  Node 24. `--check-pins` validates the lock offline. The lock is a runtime stamp input, so a pin
  change forces a re-stage. Gradle checks the staged `libnode.so` version against the lock.
- Runtime policy: `engines` `>=24 <25`. The CLI refuses Node below 24 (unchanged), warns on stderr
  for a newer major and continues, and says nothing on 24. The installer prints the same warning.
  `build:sea` refuses to build on a major other than 24.
- Tests: `tests/node-version-policy.test.mjs` (new), additions to `tests/cli.test.mjs`,
  `tests/package.test.mjs` and `tests/android-runtime-stamp.test.mjs` (`--check-pins` with 6 bad
  locks).
- Gates: `npm test`, `npm run lint`, `npm run build:frontend`, `shellcheck`, a real
  `--update-pins` run that must reproduce the committed lock byte for byte, CI 7 of 7 (the Android
  job runs the pinned fetch, `:app:testDebugUnitTest` and `:app:assembleDebug` for both ABIs), and an
  inspection of the CI debug APKs: Node string, no `libsqlite3_*.so` orphan, 16 KB alignment.
- Rollback: revert the PR. Older release artifacts stay valid. The next Android build then fetches
  Termux's newest `nodejs-lts` again, unpinned.

### PR 01b: production-only Android app tree and size report

- Build the archive's `node_modules` from `package-lock.json` in a separate directory with
  `npm ci --omit=dev --ignore-scripts` (P1-09), keep the full tree only for the frontend build, and
  keep removing native `.node` files. Remove only what a justified rule names (for example `*.map`,
  `*.d.ts`, `@types/*` if no runtime code loads them), each rule with a test.
- Make `levix-app.zip` reproducible: sorted entries, fixed times and permissions, no extra fields.
  Prove it by building twice and comparing sha256.
- Add `scripts/android-size-report.mjs` (no dependencies): component table per APK, AAB and
  `levix-app.zip`, each `node_modules` package tagged dev or production from the lockfile, delta
  against a committed baseline JSON for v4.9.2. CI builds release APKs and the AAB with the debug
  key, publishes the table in the job summary and the JSON as an artifact. Budgets start as recorded
  observations.
- Prove nothing at run time is missing: a test that loads every command, route and service module
  from the staged tree; CI boot of the staged tree on Linux x64 (`node boot.mjs` is not possible
  off-device, so the check imports `src/` against the staged `node_modules`).
- Measure v4.9.2 and the new output per ABI: `unzip -lv`, `bundletool build-apks` and `get-size
  total` for the AAB, `readelf` for every library. Play download and update sizes stay NOT MEASURED
  unless Play Console or `bundletool` gives them.
- Evaluate, without changing, whether one `levix-app.zip` hurts Play's delta updates; report only
  what can be measured.

### PR 01c: runtime dependency advisories

- `npm audit` on the root and `frontend/`, then `npm audit fix` without `--force`. No major upgrade.
  List every advisory that remains with the reason. Full gates, plus Docker, tarball and SEA in CI.

### PR 01d: Android R8 and resource shrinking (experiment)

- On a separate branch: `isMinifyEnabled` and `isShrinkResources` for release, keep rules for
  `@JavascriptInterface` methods, services, receivers and anything Kotlin reflection reaches.
  Measure `classes.dex` and resources before and after.
- Ship it only with device proof of startup, the WebView bridge, Media Hub, stickers, TLS and the
  background service. Without a device the result stays a measured experiment and is not proposed
  for merge.
- Also check the unused `libsqlite3_*` files are gone after 01a, and whether any other packaged
  library is never loaded.

### PR 01e: test-suite timing

- `tests/run.mjs` prints each file's wall time and a sorted top list. Re-time the suite on an idle
  machine (R-30). Fix a confirmed bottleneck only when the fix keeps every assertion.

## 4. Results

### PR 01a: Node.js 24 policy and pinned runtimes

Branch `build/01a-node24-pin`. Implemented by Grok (3 rounds), reviewed by Codex (read-only) and by
the orchestrator. Changed files and the reason for each are in the pull request.

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS: 70 files, 5,156 checks, 0 failed, 0 crashed, 4 min 8 s | local, Node 24.22.2, 2026-10-30 16:59:50Z to 17:03:58Z |
| `npm run lint` | PASS: 370 files, 0 errors, 174 warnings (baseline 174), 60 infos | local |
| `npm run build:frontend` | PASS | local |
| `shellcheck` (the CI list) | PASS | local, shellcheck 0.11.0 |
| `shellcheck android/scripts/fetch-node-android.sh` | 4 findings, all present on `main` before this PR (SC2207, SC2194, SC2016, SC2012); the script is not in the CI list | local |
| `fetch-node-android.sh --update-pins` against the live Termux index | PASS: rewrote the committed lock byte for byte (`cmp`) | local, network |
| `--update-pins` against fake indexes | PASS: refuses `nodejs-lts` 26.13.0, refuses rows that fail the checks, lock untouched each time; also an automated test now | local |
| Mutation checks | PASS: 9 policy regressions (workflow `node-version: 24`, Dockerfile `node:24-slim`, `ARG` differing from `.node-version`, `.node-version` 26.13.0, lock Node 26, engines `>=24`, installer warning removed, `verify-version` without setup-node, cache key without the lock) each fail `tests/node-version-policy.test.mjs`; restoring the old glob extraction or disabling both Node 24 checks in the pin helper fails `tests/android-runtime-stamp.test.mjs` | local |
| CI (7 jobs, includes the pinned Android fetch, `:app:testDebugUnitTest`, `:app:assembleDebug` for both ABIs, Docker, tarball, SEA on 3 OSes) | PASS: 7 of 7 jobs. `setup-node` resolved `.node-version` as 24.22.2. The fetch printed `Pins OK: nodejs-lts 24.22.1 for aarch64 and arm, 14 pinned files`, reused all 14 cached files after their sha256 matched, and passed the ELF checks for both ABIs. | CI run 41095734351 on `71b8646` |
| CI debug APK inspection | PASS: both debug APKs carry 11 native libraries (v4.9.2 release: 13). Neither has a `libsqlite3_*.so` copy, and each `libnode.so` carries `v24.22.1`. Debug and release APKs compress differently, so the size comparison waits for PR 01b's release builds. arm64 sha256 `0334ba35…b025fc`, armv7 `056b97e1…8706d`. | CI artifact `android-debug-apks`, run 41095734351 |
| Android device smoke | NOT RUN: no device attached | n/a |

Review: Codex reported 1 P1 and 3 P2. The three P2s are fixed. A `patchelf` failure could pass
silently, a SEA could build on another 24.x patch without notice, and `--update-pins` had no
regression test. The P1 is that Termux deletes old builds, so a cold cache cannot fetch the pins.
That needs a durable source for the pinned files, which is owner question Q-23.

### PR 01b: production-only Android archive, reproducible zip, size report

Branch `build/01b-prod-staging`, stacked on 01a. Implemented by Grok (3 rounds), reviewed by Codex
(read-only, 3 P2 findings, all fixed) and by the orchestrator.

- `stage-levix-app.sh` installs production dependencies from `package-lock.json` into a separate
  directory (`npm ci --omit=dev --ignore-scripts --no-bin-links --prefer-offline`). It no longer
  reads the repository's `node_modules`.
- Removed from the archive, each for a stated reason:
  - `ffmpeg-static`: Android ships `libffmpeg.so`.
  - `sharp` and `@img/*`: linux-x64 binaries pulled in as a Baileys peer dependency. Baileys loads `sharp` with `import('sharp').catch(() => {})`, and v4.9.2 also shipped without it.
  - `@types/*` and `*.d.ts`: type declarations Node never loads.
  - `*.node`, `*.map` and `.package-lock.json`.
  - Markdown files stay, because some packages keep their license text only in `README.md`.
- `check-stage-deps.mjs` fails the staging when app code loads a package that is missing from the
  staged tree. Result: 19 packages loaded, all present.
- `zip-tree.mjs` writes the archive with sorted entries and a fixed 1980-01-01 time. It uses no data
  descriptors, deflate level 9, or stored entries when deflate does not shrink them.
- `scripts/size-report.mjs` prints component sizes and deltas against
  `docs/plans/v5/size-baseline-v4.9.2.json`. That baseline was generated from the v4.9.2 release
  artifacts. Its numbers equal an independent Python count of the same files, byte for byte.
- CI builds release APKs and the AAB with the debug key, adds the table to the job summary and keeps
  `android-size.json` with the builds for 7 days.

| `levix-app.zip` | v4.9.2 release | PR 01b (local staging) | Change |
| --- | --- | --- | --- |
| File size | 44,217,091 | 9,861,112 | -34,355,979 (-77.7%) |
| Bytes stored in the arm64 APK | 43,078,460 | APK_STORED | APK_STORED_DELTA |
| Entries | 5,393 | 4,482 | -911 |
| Uncompressed bytes | 137,525,769 | 38,577,138 | -72.0% |
| Dev-only packages | 32,008,227 bytes (74.4%) | 0 | -100% |

Reproducibility: two local stagings produced byte-identical archives (sha256 `045337008006d4c5944e582dc83c58f04af7578d959c1e8e32491f458d8002df`).
Cross-machine check (local staging against the archive inside the CI-built APK): PENDING.

Release APK and AAB sizes from CI: PENDING.

### PR 01c to 01e

In progress; see their pull requests.
