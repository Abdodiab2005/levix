# Levix v5.0.0 scope

Labels: `SHIPPED` exists in v4.9.2 on `main`. `PLANNED` is approved scope with no code yet.
`PENDING REVIEW` waits for an owner decision (see `OPEN_QUESTIONS.md`). Nothing in this folder is a
claim about the released product until the phase that builds it is merged and its tests pass.

## 1. Locked decisions

The owner made these decisions. They are recorded as ACCEPTED ADRs in `DECISIONS.md`.

1. Node.js 24.x only, at the latest verified and compatible 24.x patch. Never Node 26 (ADR-001).
2. `levix` stays public, MIT and complete. `levix-plus` is a private, optional extension (ADR-002).
3. No required Levix Cloud. Local and self-hosted backends keep working offline where a feature
   allows it. Subscription checks and central Terms are the two allowed exceptions (ADR-003).
4. Four locales: `ar`, `en`, `pt-BR`, `es-419`. UI, bot reply and AI reply languages are separate
   settings (ADR-004).
5. React replaces the EJS login, setup, QR and fallback pages without weakening auth (ADR-005).
6. `!generate`, `!tts`, `!stt` and the AI tools are extended, not rebuilt. TTS means text to speech;
   STT means speech to text. Arbitrary sound effects are not in scope.
7. Command Engine v2 handles aliases, nested commands and a newline between command and
   sub-command, and keeps every current permission. `!status` becomes short for ordinary users;
   detailed diagnostics stay privileged. `!update` and a health check are added.
8. One generic reaction rules engine. AI Auto Reply without a prefix is opt-in (ADR-008, ADR-009).
9. Reply Router: the default is the same chat (ADR-007).
10. Levix Plus: USD 0.99 per month, 30% lower in Egypt through Play pricing. Plus adds cosmetics and
    customization only and removes no Free feature (ADR-010, ADR-012).
11. Mandatory Terms and Privacy consent from a central Leviro source with a verified local fallback.
    Acceptance is stored locally and not uploaded (ADR-006).
12. Update checker, GitHub star and optional Play review prompt, official links, Backup and Restore,
    permission improvements, diagnostics and final release validation are in scope.
13. Building the Cloud product is out of scope. No extra features or commands to enlarge scope.

## 2. Out of scope for v5.0.0

- The Levix Cloud product and any required Leviro-hosted runtime.
- Sound effect or music generation from prompts.
- New commands other than `!update`.
- Machine translation of every outgoing message at send time.
- Cloud backups, sync accounts, developer-side collection of user data.
- Plus source code, keys or stand-in implementations in this public repository.
- Automatic merge, tag, GitHub release or Google Play upload.

## 3. Feature register

| # | Feature | Today | Phase | Success definition | Needs first | Data touched | Rollback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | Node 24 pin across all artifacts | `SHIPPED` partly: Node 24 used, Android version unpinned | 01 | Every artifact reports Node 24.x; Termux `.deb` pinned by version and sha256 per ABI | ADR-001 | none | revert the pin commit |
| F-02 | Smaller Android artifacts | `PLANNED` | 01 | `levix-app.zip` holds no dev dependency; before/after sizes per ABI from artifacts; no behaviour regression | baseline in `BASELINE.md` | none | revert the staging change |
| F-03 | Backup and Restore | `PLANNED`; settings export/import is `SHIPPED` | 02 | Backup, mutate, restore, verify passes; a corrupt backup is rejected and old data stays intact | data map (`ARCHITECTURE.md` section 6) | the whole data directory | feature flag off; restore never deletes before the atomic switch |
| F-04 | Four locales across bot, dashboard, gateway and Android | `SHIPPED` for `ar`/`en` only | 03 | All four selectable and stored on Android and dashboard; no missing key or placeholder in CI | catalog design | settings `bot_language`, new UI and AI language settings | language falls back to `en`; old settings keep meaning |
| F-05 | React gateway (login, setup, QR, recovery) | `PLANNED`; EJS pages are `SHIPPED` | 04 | Every auth flow works in React; all existing negative-path auth tests still pass | F-04 | sessions, password, recovery email | keep EJS routes until the React routes pass; switch back by route |
| F-06 | Terms consent gate | `PLANNED`; no consent code exists | 04 | No WhatsApp socket is created without valid acceptance, on every start path incl. headless and Android | ADR-006, legal text review | new local acceptance record | gate disabled by a release revert; acceptance record is additive |
| F-07 | Message engine | `PLANNED`; `createStatus()` and `sendBotMessage()` are `SHIPPED` | 05 | Every reply goes through one formatting and delivery path; status edit-in-place keeps working | F-04 | none | per-command fallback to direct send |
| F-08 | Reply Router | `PLANNED` | 05 | Default stays the source chat; other destinations only when authorized; no private content reaches another chat | F-07 | new routing settings | routing settings reset to same chat |
| F-09 | Command Engine v2 | `PLANNED`; newline already splits arguments | 05 | Before/after permission matrix equal for every command except approved changes; parser fixtures pass | ADR-011 | runtime-config maps | parser switch back to v1 |
| F-10 | Short `!status` and owner health check | `PLANNED`; owner-only `!status` is `SHIPPED` | 05 | Ordinary output shows no versions, kernel or paths; health states `ok`, `degraded`, `down`, `unknown` | Q-06 | none | restore old output |
| F-11 | Documentation-aware AI | `PLANNED` | 06 | Answers cite a bundled doc section and version; planned features are never presented as shipped | approved user docs | bundled doc index | tools removed from the declaration list |
| F-12 | Natural-language image, TTS and STT | `PLANNED`; the commands and the `speak` tool are `SHIPPED` | 06 | The agent calls the existing code paths, with the same permission checks, when the provider supports them | F-07, F-08 | provider uploads of user media | tool declarations removed |
| F-13 | Reaction automation | `PLANNED`; reactions are ignored today | 07 | One engine runs every configured example; no shadow archive; idempotent on redelivery | F-08, ADR-008 | rules table, bounded message lookup | engine kill switch; rules disabled |
| F-14 | AI Auto Reply | `PLANNED` | 07 | Off by default; one reply per authorized event; kill switch works; no loops | F-08, F-12 | per-chat state, local counters | kill switch |
| F-15 | Plus extension contract, billing, personalization | `PLANNED` | 08 | Free builds and passes with no Plus code; entitlements verified server-side; Core works offline | F-07, F-04, private repo access | entitlement cache, template overrides | Plus disabled; Free defaults return |
| F-16 | Update checker and `!update` | `PLANNED` | 09 | Correct per channel; no download or run of code; offline handled | F-09 | small local cache | command disabled |
| F-17 | Official links, rating and star prompts | `PLANNED` | 09 | Links open safely; prompts respect Play limits and never gate features | none | local dismiss flags | remove prompts |
| F-18 | `Powered by Levix` watermark | `PLANNED` | 05 engine, 09 rules, 08 removal | Never alters raw output, security text or formats | F-07 | none | watermark off |
| F-19 | Release candidate audit | `PLANNED` | 10 | Go/No-Go with evidence; no critical or high open defect | all phases | all | no release |

## 4. Definition of done for every phase

1. Acceptance criteria written in `PHASES.md` before code changes start.
2. Tests named in `TEST_MATRIX.md` pass, or are labelled `NOT RUN` or `BLOCKED` with the reason.
3. Security and privacy notes in `RISKS.md` reviewed for that phase.
4. Public docs changed only for behaviour that shipped in that phase.
5. A dated entry in `CHANGELOG.md` with the PR link.
6. The owner approves before the next phase starts.
