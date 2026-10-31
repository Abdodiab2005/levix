# Levix v5.0.0 risk register and threat notes

Likelihood and impact use Low, Medium and High. "Stop trigger" names the observation that halts a
phase or reverts a change. Owners are phases; the release owner is the project owner.

## 1. Register

| ID | Risk | Phase | Likelihood | Impact | Mitigation | Stop trigger |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Termux promotes `nodejs-lts` to 26.x and the next Android build ships Node 26. | 01 | High | High | Done in PR 01a: `android/scripts/termux-packages.lock` pins version and sha256 per ABI; the fetch refuses other bytes and a `libnode.so` that is not the pinned 24.x; `--update-pins` refuses a non-24 `nodejs-lts`; Gradle checks the staged version. Remaining exposure: R-33. | Any artifact reports a major other than 24. |
| R-33 | Termux serves only the newest build of each package (an older `nodejs-lts` answers HTTP 404), and the Actions cache is evicted, so a cold build could lose its Node source. A new Node 24 patch still needs a Termux build; once Termux moves `nodejs-lts` to 26.x, no Termux source for a newer Node 24 remains. | 01 to 10 | Medium | High | ADR-018: builds use one pinned release archive and never contact Termux; a separate backup copy exists; the archive rebuilds deterministically from the pinned debs. A Node 24 patch after Termux moves on needs a source build (owner decision). | A pinned archive download fails, or Node 24 needs a security patch that Termux does not ship. |
| R-02 | A production-only `node_modules/` misses a package that Levix loads at run time. | 01 | Medium | High | Build the tree from the lockfile; boot smoke on both ABIs; a test that loads every command and route module from the staged tree. | Boot, pairing or a command fails on device. |
| R-03 | R8 or resource shrinking removes classes used by JNI, the WebView bridge (`@JavascriptInterface`) or reflection. | 01 | Medium | High | Experiment on a branch; keep rules; device test of `PanelBridge` and Media Hub. | Any bridge call fails on device. |
| R-04 | A v5 migration fails on a real v4.9.x database. | 02 to 08 | Medium | High | Append-only migrations; backup before migrating; tests with v4.9.x fixture databases. | Migration test fails or data differs after upgrade. |
| R-05 | A backup exposes secrets: `levix.key` together with the database opens every sealed value, and `secret:session` is unsealed. | 02 | Medium | High | Every exported backup is encrypted with the operator's password; `levix.key`, pairing credentials, panel secrets and the session key are never included; API keys are sealed again with the target's key; no secret in previews or logs. | A test finds a pairing credential, panel secret or device key in a decrypted backup, or any secret in a preview or log. |
| R-06 | An interrupted or corrupt restore damages the live data. | 02 | Medium | High | Stage, verify checksums, switch atomically, keep the old copy until the restarted app is healthy. | Old data not intact after a failed restore test. |
| R-07 | A crafted backup uses path traversal, symlinks, a decompression bomb or extreme KDF parameters. | 02 | Low | High | Reject `..`, absolute paths and links; cap entry count, sizes and KDF cost. | Any fuzz case escapes the staging directory. |
| R-08 | A second process writes the database during backup or restore (`levix reset-password` takes no lock). | 02 | Low | Medium | Use the SQLite backup API; take or check the instance lock in every writer. | Snapshot differs from a quiesced copy in tests. |
| R-09 | The locale migration changes current Arabic or English replies, or ships a missing key or placeholder. | 03 | Medium | Medium | Catalog validator in CI; extend `tests/reply-language.test.mjs` and `tests/help-i18n.test.mjs` to all locales. | Validator or reply-language test fails. |
| R-10 | Moving login, setup, QR or recovery to React weakens auth. | 04 | Medium | High | Server checks stay unchanged (ADR-005); all current auth tests plus new negative tests. | Any auth negative test fails. |
| R-11 | A start path creates a socket without consent (retry timer, network restore, headless, Android boot). | 04 | Medium | High | Check inside `WhatsAppSession` before `#open()` (ADR-006); one test per path. | Any path opens a socket without acceptance. |
| R-12 | The consent gate locks out existing users, needs the network, or deletes pairing credentials. | 04 | Medium | High | Bundled Terms accepted offline; acceptance UI never touches credentials; one-time v4 upgrade flow. | Offline first start cannot accept; credentials change. |
| R-13 | Remote Terms content injects script, changes UI or links to a phishing payment page. | 04 | Low | High | Plain text or structured paragraphs only; integrity check; size and type limits; link allowlist. | Injection test renders active content. |
| R-14 | The Reply Router sends private or group content to another chat. | 05 | Medium | High | Audience rule: content goes only where the readers can already read the source chat; sensitivity classes; fail closed; never fall back to a group (ADR-007). | Any routing test leaks content. |
| R-15 | Command Engine v2 changes who may run a command. | 05 | Medium | High | Before and after permission matrix for all 69 commands (ADR-011). | Unapproved matrix difference. |
| R-16 | The docs tool presents planned features as shipped, or indexed text injects instructions. | 06 | Medium | Medium | Index shipped user docs only; treat retrieved text as data; tests with injected docs. | A test answer claims a `PLANNED` feature. |
| R-17 | Media tools upload private media or run up provider costs. | 06 | Medium | Medium | `access` entries; size, rate and timeout limits; capability gating per provider. | Tool runs for an unauthorized caller. |
| R-18 | Reactions replay after reconnect, run privileged actions for an unauthorized reactor, or require archiving messages. | 07 | Medium | High | Idempotency key per reaction event; existing permission checks; bounded lookup only for chats with rules (ADR-008). | Duplicate action or unauthorized action in tests. |
| R-19 | AI Auto Reply loops or mass-replies and gets the WhatsApp account banned. | 07 | Medium | High | Off by default; allowlists; rate limits; loop detection; kill switch (ADR-009). | More than one reply per event in tests. |
| R-20 | Plus code or keys leak into a public artifact; a forged purchase unlocks Plus; a billing outage disables Core. | 08 | Low | High | CI check on public artifacts; server-side purchase verification; Core never reads entitlement. | Public artifact contains Plus code; Core test fails offline. |
| R-21 | The update checker follows a malicious URL, reports a wrong channel, or forces updates. | 09 | Low | Medium | Origin allowlist; semver and channel tests; no downloads (ADR-013). | Test reaches a non-allowlisted host. |
| R-22 | WebView link handling opens `intent://`, `javascript:` or `file://` URLs, or exposes panel cookies. | 09 | Low | High | Scheme and host allowlist; external links open in the browser. | Abuse test succeeds. |
| R-23 | The watermark corrupts raw output, security text or long messages. | 05, 09 | Medium | Low | Exclusion rules in the message engine (ADR-012). | Exact-output test changes. |
| R-24 | `PRIVACY.md` and the Play Data safety form under-declare current data flows. | 00 to 10 | High | High | Mitigated by PR #82 (Q-11, Q-27, 2026-10-31): every destination named and mapped. The owner still updates the Play Console form from `PRIVACY.md` section 7. Re-audit at every phase that adds a destination. | A destination ships without a privacy row. |
| R-25 | A Leviro call (Terms, entitlement, update) on the start-up path stalls or blocks start when offline. | 04, 08, 09 | Medium | Medium | No network call on the critical start path; timeouts; cached values. | Offline start slower than the v4 baseline. |
| R-26 | `memory/global.md` reaches group prompts; Auto Reply widens that exposure. | 07 | Medium | Medium | Q-09 decides scope; Auto Reply in groups uses chat memory only until then. | Group test prompt contains global memory. |
| R-27 | React gateway uses browser features that old Android WebViews lack (minSdk 29). | 04 | Medium | Medium | Build target and smoke test on the oldest supported WebView. | Gateway fails on the old WebView. |
| R-28 | Delegated implementers widen scope, reformat unrelated files or run tests themselves. | all | Medium | Medium | Briefs list exact files; the orchestrator runs every gate and reviews each diff. | Diff touches files outside the brief. |
| R-29 | Closed 2026-10-30: the local branch `zcode/commands-panel-upgrades` is patch-identical to `main` (AUDIT E-06). | 02 | none | none | none | none |
| R-30 | The 11-minute stall seen in one local `npm test` run hides a real hang. | 01 | Low | Medium | Re-time on an idle machine; per-file timing in `tests/run.mjs` output. | A file exceeds its time budget in CI. |
| R-31 | Importing the store migrates the database before the single-instance lock, so a second process can migrate before it fails the lock, and no backup can run first. | 02 | Low | High | Phase 02 start order: open, lock, detect pending migrations, back up, migrate (AUDIT B-09). | A test starts two processes against one data directory and sees a migration from the losing one. |
| R-32 | An AI answer routed to a second chat discloses memory or group content, even when the sender belongs to both chats. | 05, 07 | Medium | High | AI answers count as content-bearing replies under the ADR-007 audience rule; `global.md` scope per Q-09. | A routed AI answer in a test contains another chat's content or global memory. |

## 2. Threat notes by v5 area

### Reply Router (Phase 05)

- Assets: message text, transcripts, quoted media, AI memory, group membership.
- Threats: a member configures or triggers a route to a chat they control; a forged `chatId` in a
  tool argument; a fallback to a group when the private chat is unreachable.
- Controls: destinations are resolved and checked in the backend from the real sender; routes are
  configured only by the owner; failures produce a neutral notice in the source chat.

### Reactions (Phase 07)

- Threats: a reaction from someone without permission runs an action; redelivery after reconnect
  runs an action twice; the lookup grows into a message archive.
- Controls: the reactor is the caller for authorization; one idempotency key per
  `(chat, message, reactor, emoji)`; time and size limits on the lookup.

### AI Auto Reply (Phase 07)

- Threats: reply loops with other bots; mass replies; prompt injection from incoming messages that
  asks for tools; private memory in group answers.
- Controls: opt-in per chat; rate limits and debounce; ignore own, forwarded, edited and replayed
  messages; tools keep `aiToolAuth.cjs` checks.

### Plus extension (Phase 08)

- Threats: proprietary code in public artifacts; client-side `isPlus` flags; forged purchase tokens;
  identity tracking through billing.
- Controls: CI artifact scan; entitlement verified by a Leviro service using the Play Developer API;
  minimal stored data with a retention policy.

### Start-up without Levix Cloud (Phases 04, 08, 09)

- Threats: an unreachable Leviro host blocks start; a cached value is trusted forever.
- Controls: bundled Terms fallback; grace periods with clock checks; Core never waits for Leviro.

### Central Terms with local fallback (Phase 04)

- Threats: tampered remote text; downgrade to an old version; script in content.
- Controls: version and hash checked; signature or pinned-hash scheme decided in Phase 04; plain
  text rendering only.

### Restoring backups (Phase 02)

- Threats: tampered or truncated archives, path tricks, inflation bombs, KDF cost abuse; newer schema
  than the app; wrong password; restore during writes; one account's data attached to another
  WhatsApp account.
- Controls: authenticated chunk stream and manifest checks before staging; refusal of newer
  schemas; journaled steps with recovery at start; account data activates only for the same
  WhatsApp account; WhatsApp pairing is never restored, the operator pairs manually.

### Model tool calls (Phase 06)

- Threats: a tool acts for the wrong user; arguments name a chat or user the caller does not own;
  unsafe URLs; provider output treated as instructions.
- Controls: `access` entries checked against the minted caller; identities taken from the caller,
  never from arguments; `fetch_url` HTTPS and private-range checks stay.
