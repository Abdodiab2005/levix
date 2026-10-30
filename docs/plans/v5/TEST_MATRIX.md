# Levix v5.0.0 test matrix

Result labels: `PASS`, `FAIL`, `NOT RUN`, `BLOCKED`. Every result records the command, the
platform, the commit, the date and where the evidence lives. A result without that record does not
count. Delegated implementers do not run these gates; the orchestrator runs them and reviews the
output.

## 1. Current suites (baseline 2026-10-30, commit `050d8b9`)

| Suite | Size | Where it runs | Baseline |
| --- | --- | --- | --- |
| `npm test` (`tests/run.mjs`) | 68 files, 5039 checks | local and CI `tests` job | PASS |
| `npm run lint` (Biome) | 368 files | local | PASS, 174 warnings |
| `npm run build:frontend` (Vite, `tsc -b`) | 3 output files | local and CI | PASS |
| `npm run validate:tarball` | packs, installs, boots | CI `package` job | PASS in CI |
| `npm run validate:sea` | Linux, macOS, Windows | CI `sea` jobs | PASS in CI |
| `npm run validate:docker` | build, start, claim, restart, upgrade | CI `docker` job | PASS in CI |
| Android `:app:testDebugUnitTest` | 9 test classes | CI `android` job | PASS in CI; BLOCKED locally (no staged runtime) |
| Android `:app:assembleDebug` | both ABIs | CI `android` job | PASS in CI |
| Device smoke | none automated | manual | NOT RUN |

## 2. Platforms and channels

| Channel | Gate owner | Minimum check per phase that touches it |
| --- | --- | --- |
| npm global install (Linux x64) | CI `validate:tarball` | install and boot |
| SEA Linux x64, macOS arm64, Windows x64 | CI `validate:sea` | binary runs with no source tree |
| Docker | CI `validate:docker` | volume survives restart and upgrade |
| Headless (`levix headless`) | `tests/headless.test.mjs` | panel modules never load |
| Android arm64-v8a | release build plus manual device smoke | start, pair a dedicated test account (manual, owner-authorized), panel, Media Hub, stickers |
| Android armeabi-v7a | release build plus device or emulator smoke | same as arm64 |
| Oldest supported WebView (minSdk 29) | manual | gateway and dashboard render and log in |

## 3. Gates by phase

| Phase | Required gates | Phase-specific tests |
| --- | --- | --- |
| 01 | all of section 1, both ABI release builds, size report | staged tree contains no dev dependency; `libnode.so` major is 24; 16 KB alignment; FFmpeg `libwebp` encoders; TLS roots; boot smoke on device |
| 02 | section 1 core gates | backup and restore end to end; corrupt and interrupted restore; path traversal, symlink, bomb and KDF fuzz; wrong passphrase; newer schema refused; settings export unchanged |
| 03 | core gates, Android unit tests | locale matrix for help and replies; catalog validator; placeholder parity; RTL and LTR smoke; Android locale switch without network |
| 04 | core gates, Docker, SEA, Android unit tests | auth negative paths; consent on every start path; offline first start; tampered Terms; old WebView |
| 05 | core gates | parser matrix; permission matrix for 69 commands; routing privacy; status editing; health without network |
| 06 | core gates | mocked providers; tool authorization; docs retrieval and injection; four-locale queries |
| 07 | core gates | fake event streams; idempotency; loops; rate limits; restart; permissions per reactor |
| 08 | core gates plus Free-only build | no Plus code in public artifacts; forged and revoked entitlements; offline Core |
| 09 | core gates | semver and channel matrix; link scheme abuse; review prompt declined; watermark exclusions |
| 10 | everything above plus artifact comparison with `BASELINE.md` | full feature matrix in four locales |

"Core gates" means `npm test`, `npm run lint` and `npm run build:frontend`.

## 4. Test rules carried into v5

- No real WhatsApp number, recovery email, purchase, feedback or crash upload in any test. Use fakes,
  `LEVIX_FEEDBACK_URL` and `LEVIX_RECOVERY_URL` overrides, and isolated data directories.
- No real user data in fixtures. Fixture databases are built by the test.
- A test that needs the network is a bug. Phase 01 runs one CI pass of `npm test` without network to
  prove it (the isolated `reply-language` run in `BASELINE.md` section 7 already passes offline).
- Google Play download and update sizes are reported only from Play Console or `bundletool` output.
