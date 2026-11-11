# Levix v5.0.0 open questions

The questions under "Still open" need an owner decision. Decided before Phase 00 and not repeated
here: Node 24 only, the four locales, USD 0.99 with 30% off in Egypt, Plus as a private repository,
Cloud as a separate product, offline-first, same-chat reply default, and one generic reaction engine.

Each open question lists options and a recommendation. "Needed by" names the first phase that is
blocked without an answer.

## Decided by the owner (2026-10-30 unless the row says otherwise)

| ID | Decision | Where it lands |
| --- | --- | --- |
| Q-01 | Option (b). Every official build (Android, Docker, SEA, CI) uses Node 24, at the latest verified 24.x patch at build time (v24.22.2 on 2026-10-30). A self-hosted user may run Node 26 or later: Levix starts with a clear warning that the version is not officially supported, and support is best effort. Below 24 it refuses to start. `package.json` (`engines` `>=24 <25`), the CLI and the docs must state this one policy. No move to Node 26. | ADR-001; Phase 01 PR 01a |
| Q-02 | Review first. Result: both commits on the local branch `zcode/commands-panel-upgrades` are patch-identical to `main` commits `ec1d762` and `cb9d09a` (`git cherry` marks them `-`). Nothing is missing from `main`, so nothing moves to Phase 02. The branch exists only locally; it stays until the owner deletes it. | AUDIT E-06 |
| Q-07 and Q-08 | Permission differences are fixed in Phase 05 from the before-and-after permission matrix. No change may widen anyone's access without the owner's explicit approval; each widening case comes back as its own question. | ADR-011; Phase 05 |
| Q-11 | A separate PR now updates `PRIVACY.md` and the public docs with every real data destination, and reviews the Data safety answers against Google's official definitions without assuming that every external connection is "Shared". | PR #82, Phase 01 scope |
| Q-12 | Remove `youtube_api_key` from the settings definitions, the dashboard and the docs. Saved values are not deleted automatically. | PR #81, Phase 01 scope |
| Q-13 | A separate bug-fix PR makes `!prayer` use the current date and the configured timezone, encodes the URL, and adds tests. | PR #83, Phase 01 scope |
| Q-21 | Option (a). `!schedule` errors keep going to the creator's private chat; password-reset codes keep going to their current private destination. | ADR-007; Phase 05 |
| Q-23 | 2026-10-31: no upload of the 14 `.deb` files. One deterministic archive with both ABIs (unmodified runtime files, upstream licence texts, a manifest with full provenance), published as the only asset of a dedicated GitHub prerelease, pinned by sha256, with a local backup, and a cold-cache CI build before merge. | ADR-018; R-33 |

## Decided by the owner on 2026-10-31 (privacy, PR #82)

| ID | Decision | Where it lands |
| --- | --- | --- |
| Q-27 | Gemini Google Search grounding and the AI web-search tools stay on as designed. `PRIVACY.md` discloses every AI, search, translation, TTS and other transfer without changing behaviour. Feedback is described as sent to Leviro Support, with the current Telegram delivery stated until a private dashboard replaces it. The Data safety map applies Google's definitions: transfers whose destination the AI agent or an optional setting chooses are declared shared; user-initiated and service-provider transfers are collected only. A city name typed into `!weather` or `!prayer` is declared as Approximate location, separate from device location, which Levix never collects. | `PRIVACY.md` section 7; PR #82 |

## Decided by the owner on 2026-10-31 (Phase 02)

| ID | Decision | Where it lands |
| --- | --- | --- |
| Q-10 | Option (a). Android preferences and other device data stay out of backups. | `BACKUP_FORMAT.md` section 7; Phase 02 |
| Q-14 | Option (b). Backup and restore run from the React panel and the Android app only: no CLI command and no WhatsApp command. A headless install without a panel cannot back up in v5. | `BACKUP_FORMAT.md` section 10; PRs 02g and 02h |
| Q-22 | Every exported backup is encrypted with a user-provided password and holds the API keys. A restore seals the API keys again with the target's `levix.key`, keeps the target's panel password, session key and recovery email, and never imports WhatsApp pairing; the operator pairs manually. A new install goes through the normal setup first. | ADR-016; PR 02e |
| Q-24 | Account data activates only after the paired WhatsApp account is verified to match the backup's account (LIDs when both are known, phone numbers otherwise). Until then it waits and the operator can discard it. | `BACKUP_FORMAT.md` section 8; PR 02f |
| Q-25 | AI memory lives in `<data>/memory`. A legacy `PACKAGE_ROOT/memory` is copied there once. | PR 02c |
| Q-26 | A verified local pre-migration copy (mode 0600, never exported, newest two kept) that holds every table and every row except the secret material: no WhatsApp pairing, no panel password hash, no recovery email, no session key and no API key. `src/db/copy.cjs` writes it, verifies it and renames it from a `.part` file. All pending migrations run in one transaction. Recovery from a copy is a documented manual step, since there is no CLI restore: the rollback steps are in `MIGRATION.md` section 5. A rollback leaves the install with no pairing and no panel password, so the next start goes through `/setup` again and the operator pairs WhatsApp by hand. Amended 2026-10-31 after the #91 review. | ADR-016; PR 02b |

## Decided by the owner on 2026-11-01 (Phase 03)

| ID | Decision | Where it lands |
| --- | --- | --- |
| Q-15 | Option (b). The recovery relay in `levix-ui` gains `pt-BR` and `es-419` mail in step with Phase 03. The relay deploys before the Levix change that sends those values merges. | `PHASE-03-RESULTS.md` section 3.10; PR 03h |
| Q-19 | ChatGPT reviews the `pt-BR` and `es-419` translations before each translation PR merges. The catalog records a machine review by ChatGPT, not a native-speaker review. Amended 2026-11-02: ChatGPT is the approved Phase 03 reviewer; native-speaker review is not required to merge. | `PHASE-03-RESULTS.md` section 3.9; PR 03g |

## Decided by the owner on 2026-11-02 (Phase 04)

| ID | Decision | Where it lands |
| --- | --- | --- |
| Q-03 | Option (a). Remote Terms and Privacy documents are accepted only with a valid Ed25519 signature checked against a public key bundled in the app. The app also bundles a trusted local copy, so a first acceptance works offline and never depends on a Leviro server. | ADR-019; PR 04c |
| Q-04 | Options (a) and (c). An interactive CLI command prints the documents and asks for typed confirmation. A separate provisioning command for Docker and unattended installs takes the Terms version and sha256 and refuses on any mismatch. No start-command flag and no environment variable accepts the Terms. | ADR-006; PR 04a |
| Q-05 | Option (a). A live WhatsApp connection stays up when the Terms change. The next connection or start, including an automatic reconnect, needs the new acceptance first. No forced disconnect. | ADR-006; PR 04a |
| Q-17 | Overrides the earlier recommendation (b). Consent belongs to the installation, not to a WhatsApp account. Acceptance is required on first install, when the Terms or the Privacy Notice change, and when Levix runs a new application version even if the documents did not change. Unlink, relink, a different account, a reconnect, a process, service or device restart without a version change, and a panel password reset keep the acceptance. The record (app version, Terms version, content hash, locale, time) stays local: it is not uploaded and not carried by Backup and Restore. | ADR-020; PR 04a |

## Still open

| ID | Question | Options | Recommendation | Needed by |
| --- | --- | --- | --- | --- |
| Q-06 | Who may run the short `!status` by default? | (a) keep `OWNER_ONLY` and make the output short; (b) `MEMBERS` for the short output, with `!status debug` owner only | (a). It keeps today's permission. Operators who want members to see it can lower it in the panel. | 05 |
| Q-09 | Should `memory/global.md` stay in every agent prompt (today: groups and other people's private chats too)? | (a) keep; (b) the owner's own private chat only, other chats by explicit per-chat opt-in; (c) per-group opt-in only | (b), before AI Auto Reply ships, because Auto Reply answers contacts who should not see the owner's global facts. (Agreed with codex review.) | 08 (Plus) |
| Q-18 | Which documents feed the documentation-aware AI? | (a) public docs in this repository only; (b) plus the website docs from `levix-ui` | (a) first. Website docs need their own version tags before they can be cited. | 06 |
| Q-20 | Should Plus entitlements work on desktop and self-hosted installs? | (a) Android Play only in v5; (b) a portable entitlement design now | (a). The phase prompt marks portability as an open design question. | 08 |

## Resolved by Phase 09 measurement (2026-11-11)

Q-16: option (a), one build. Under the owner's instruction to measure before
choosing flavors, CI run 43067593302 shows only three new Play modules, no
new selected Google services module and no new manifest permission, feature or
shared library. Non-Play calls fail before Play client creation. See
`PHASE-09-RESULTS.md` and its committed `play-impact.json`. Physical no-GMS
device QA remains NOT RUN; this does not claim Play download-size measurements.
