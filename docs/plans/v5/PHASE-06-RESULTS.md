# Phase 06: documentation-aware AI and media tools

Date: 2026-11-06. Base: `release/5.0.0-beta.1` `a68696d` (Phase 05 merged in
`3aee413`). Branch: `feat/v5-phase-06`. Status: `IMPLEMENTED — PENDING REVIEW`, not merged.
Implementation commit: `bb69ea6d1ddea3dd9e15908bcbe035d482e7bdce`.
Draft PR: https://github.com/Abdodiab2005/levix/pull/134, targeting
`release/5.0.0-beta.1` so the owner's version preparation stays separate.
The owner authorized Phase 06 and delegation to agy, OpenCode free models and
Grok on 2026-11-06. No Phase 07 work is included.

## Audit and acceptance plan (written before application edits)

The existing tree already exports `tts._synthesizeVoice()` and `stt.transcribe()`.
The `speak` tool reuses TTS and checks the live `tts` command permission.
Image generation is inline in `gemini.execute()` and assumes base64 is an image
without checking its encoding or signature. `downloadMedia()` collects a stream
without a byte limit. `resolveCaller()` mints frozen callers; `runTool()` drops
undeclared arguments and checks `access` before calling a tool. The dispatcher
passes a socket proxy that routes results through `src/messaging/router.cjs`.
All provider adapters discover declarations from the same tool registry.

The Phase 05 planning status is stale: PR #132 is already merged in `3aee413`.
There is no documentation index in the current runtime. The distribution copies
`src/`; a statically required generated JSON index can also be bundled by
esbuild for SEA, without runtime filesystem scans or new dependencies.

### Scope and files

1. **06a docs:** new `scripts/build-ai-docs.mjs`,
   `src/services/aiDocs.cjs`, `src/services/levix-docs.generated.json` and
   `tests/ai-docs.test.mjs`. Allowlist only README, SETUP, ANDROID, PRIVACY and
   the four public command catalogs. Deterministic generation, release version
   and source digests; bounded sections, query, result count and output; stable
   source IDs; language-aware ranking with explicit English fallback. Two tools
   are registered in `src/services/aiTools.cjs` and offered to every provider.
2. **06b media:** extend `src/commands/gemini.cjs`, `tts.cjs`, `stt.cjs`,
   `src/utils/geminiMedia.cjs`, `src/services/aiTools.cjs`,
   `src/services/aiToolAuth.cjs`; introduce a media helper only if shared
   ownership requires it. Reuse the command implementations. Bind audio to the
   invoking message, never model-supplied URLs, media, identities or destinations.
   Add image and transcription tools; retain `speak`. Validate binary results,
   cap input/output, rate, concurrency and duration, prevent delayed sends after
   timeout, and check live command permissions and capability switches.
3. **Integration and evidence:** `src/config/ai-identity.cjs`,
   `src/services/aiAgent.cjs` and `src/services/aiProviders.cjs` for code-owned
   documentation/media policy and validated citations;
   `tests/ai-media-tools.test.mjs`, `tests/ai-docs-integration.test.mjs`,
   `tests/ai-prompt.test.mjs`, `tests/package.test.mjs`, existing AI/media tests where necessary;
   `package.json` and CI only for generated-index validation. Update README,
   PRIVACY, AGENTS, command catalogs in all four locales, generated i18n outputs
   `src/utils/messageContent.cjs` for audio reply wrappers,
   `docs/AI_TOOLS.md` and relevant v5 phase/changelog docs for the actual contracts.

### Decisions and invariants

- Retrieval is local and read-only. Planning files, agent instructions, the
  persona, secrets, user memories and arbitrary files are never indexed. Retrieved
  text is a tool result, not a system instruction. Answers cite the bundled
  version and section and admit missing evidence; planned Plus/Cloud features
  must never be presented as installed Core features.
- Official links remain code-owned. Do not invent deep documentation URLs;
  use verified existing routes or the existing official website/GitHub links.
- Chat remains on `ai_provider`. Images use the existing dedicated Gemini
  image configuration; TTS uses Google TTS/FFmpeg; STT keeps the existing
  Gemini/OpenAI-compatible policy. Missing support, keys or quota is an error,
  never fabricated success. No music or sound-effect generation.
- Media uploads require an invoked AI/command action and the real caller's
  permission. Do not eagerly upload a voice attachment to an unrelated chat
  provider before an authorized transcription tool reads it. No ambient message
  capture, cross-chat lookup or new persistent media archive.
- Keep Phase 05 routing. A refused send is not success and must never fall back
  to another group. Provider errors/tool metadata must not disclose credentials,
  input text, audio bytes or private messages.

### Migration, threats, privacy and compatibility

No database migration, new dependency, background service, mandatory cloud,
environment variable or downloaded executable code. Pairing and keys remain
untouched. Threats: instruction injection in docs/media; forged caller/tool
arguments; URL/SSRF injection; malformed or oversized binary; quota amplification;
timeout followed by late send; unauthorized output routing; stale docs and
incorrect claims of provider support. Tests use fakes and isolated data only.

Documentation search makes no external request; the chosen chat provider receives
retrieved excerpts only during an AI turn. Image/TTS/STT keep their existing
external services; privacy docs must explain the additional natural-language
entry points, limits and optional provider costs.

Compatibility: npm, Docker and Android ARM64/ARMv7 receive the committed index
inside `src/`; SEA must statically include it. No Android native or browser
surface changes are planned. Headless imports no panel. Node 24 remains the
official runtime. This workstation currently runs Node v24.19.0, whereas the
official build pin is v24.22.2; record that limitation in test evidence.

### Acceptance and verification

The orchestrator runs all gates; implementers run no tests or builds.

- Docs: deterministic freshness/version/source check, bounded search/open,
  stable IDs, unknown/stale index rejection, all four query languages and
  fallback, no plans/private files, official link integrity and injected text
  staying outside the system instruction; packaging inclusion.
- Media: discovery in Gemini/OpenAI/Anthropic, image bytes, audio payload and
  transcript; missing/unsupported provider and key, quota, malformed/oversized
  output, unsafe URL, missing media, rate and time limits, bad arguments,
  forged/unauthorized caller, live disabled command, source-chat routing and
  refused delivery. Verify existing commands remain usable through shared code.
- Focused regression: AI authz, features, prompt, provider, Gemini media and
  reply-router tests. Final gates: `npm test`, `npm run lint`,
  `npm run i18n:check`, `npm run build:frontend`, generated docs check and
  distribution proof appropriate to the static JSON index.

Baseline: `node tests/run.mjs ai-tool-authz` PASS, 108 checks, Linux Node
v24.19.0, base `a68696d`, 2026-11-06. Release preparation checks before branching:
release identity 42 checks PASS; Node version policy 48 checks PASS; npm,
lockfile and Android beta version parity PASS. No release was published.

### Rollback

Revert Phase 06 commits together, removing the new tool declarations and index.
No stored data changes need undoing. Existing explicit commands remain the
fallback. Keep caller authorization and the Phase 05 reply router on every send.

## Implementation and gate results

Implemented 06a and 06b. The final source matches the plan above, with image
generation owned by the shared `src/services/aiImage.cjs` helper and media
limits in `src/services/aiMedia.cjs`. Tool contracts are in `docs/AI_TOOLS.md`.

### Resulting behavior and architecture

- `search_levix_docs` and `open_levix_doc_section` use a statically required
  index: 360 sections, schema 1, release `5.0.0-beta.1`, 189709 bytes of JSON.
  The generator checks the exact public allowlist, version and source digests.
  Search returns at most five bounded excerpts; open returns at most 4000
  characters. Localized command docs and a small topic bridge support the
  four locales, with explicit English fallback. No embedding or external
  retrieval service, runtime directory scan or invented deep documentation URL.
- Gemini, OpenAI-compatible and Anthropic offer the same declarations and
  collect citations from actual indexed section IDs. `formatSources()` appends
  the source, section and bundled version independently of model phrasing.
  Retrieved excerpts/transcripts remain tool data, outside system instructions.
- `generate_image` shares Gemini image generation with `!generate`; `speak`
  shares TTS; `transcribe_audio` shares STT. Chat selection stays on
  `ai_provider`. The image helper requires canonical base64 and a supported
  raster container/header. Transcription and TTS check audio MIME/header/bytes.
  These are bounded container checks, not a new full codec decoder.
- Media tools require the real minted caller, live command permission and an
  enabled backing command. `generate` uses the `gemini` permission, matching its
  alias. The disabled-command check also closes the pre-existing AI-tool bypass
  for memory, schedules, polls and roles. No default permission is widened;
  the 69-command matrix and existing authorization tests pass.
- Private audio selection is snapshotted in a WeakMap at `resolveCaller()`.
  Ordinary AI audio turns are now lazy transcription; audio is not eagerly
  sent to an unrelated chat provider. The explicit `add`/`send` batch retains
  its existing native media behavior. The new tool is speech transcription,
  not a general non-speech sound-analysis or music-generation interface.
- Model-initiated media shares three attempts per sender per minute, one
  concurrent operation, 8 MiB byte limits, 3000-character speech/image input,
  12000-character transcript output and the configured tool deadline capped
  at 120 seconds. A timed-out non-cancellable operation stays busy; late
  completion cannot send. Refused routing is an error. STT/TTS share their
  input/output limits with explicit commands; other AI downloads cap at 64 MiB.
- Explicit STT provider choices now fail closed when that provider lacks a key,
  instead of silently uploading to the other provider. `auto` keeps the prior
  available-key fallback. The transcript can then reach the chat provider and
  AI history; the Privacy table and Play Data safety mapping document that path.
  TTS temporary files use random names/private permissions and are cleaned on
  normal success/failure/abort. No database migration or new dependency.

Existing ADRs apply: ADR-003 (offline-first), ADR-004 (locales), ADR-007
(routing), ADR-011 (permissions), ADR-014 (evidence), ADR-015 (phase/release
control). Phase 06 follows Q-18 recommendation (a), public repository docs
only; website retrieval remains outside this implementation. No new product
or billing decision is assumed.

### Test evidence

Date for every row: **2026-11-06**. Platform: **Linux x64, Node v24.19.0**.
Implementation: **`bb69ea6`**. Official builds remain pinned to v24.22.2;
the local SEA correctly warns that it embeds v24.19.0.

| Command / proof | Outcome |
| --- | --- |
| `npm test` on `bb69ea6` | **PASS**, 9919 checks, 0 failed, 0 crashed files, 161.9 seconds |
| `npm run lint` on `bb69ea6` | **PASS**, 0 errors; 196 warnings and 73 informational diagnostics remain |
| `npm run build:frontend` (also invoked by `build:sea` on `bb69ea6`) | **PASS**, TypeScript and Vite; existing chunk-size warning |
| `npm run i18n:check` on `bb69ea6` | **PASS**; two gateway review-digest notices are already present in base `a68696d`, verified against its files |
| `npm run docs:check` on `bb69ea6` | **PASS**, exact generated-file/version/source freshness |
| `npm run validate:tarball` | **PASS**, 36 checks, packed/installed/booted artifact; ran immediately before the implementation commit against the same packaged source inputs |
| `npm run build:sea` on `bb69ea6` | **PASS**, Linux executable built; local embedded Node v24.19.0 |
| `npm run validate:sea` on `bb69ea6` | **PASS**, 51 checks, executable copied away from source and dependencies |
| esbuild docs-module bundle, executed with cwd `/tmp` | **PASS**, bundled JSON present in the metafile; Arabic backup search works without source-tree reads |
| Docker runtime validation | **NOT RUN**; the existing `COPY src ./src` includes the committed index |
| Android ARM64/ARMv7 build and device QA | **NOT RUN**; the existing staging copies `src/`; no native/Gradle change in Phase 06 |
| macOS/Windows SEA, live provider and live WhatsApp media QA | **NOT RUN** |

Focused cases are included in the full passing suite: docs integration 45,
docs retrieval 79, image 18, media tools 63, prompt policy 141, existing AI
authorization 108, existing AI features 46, Gemini media 60, providers 104,
command matrix 106, reply router 24, package 62, release identity 42 and Node
policy 48 checks. Fakes verify image/audio/transcript results, unsupported or
malformed responses, missing keys, quota, forged callers, disabled commands,
URL rejection, byte/rate/concurrency/deadline limits, late-send suppression and
actual dispatcher routing. No real recipient, recovery mail or production
feedback/telemetry endpoint was used.

The first full run was **FAIL**: a late output from the interrupted broad
OpenCode session replaced the docs test with incompatible imports, and the
local `ffmpeg-static` binary was absent. The exact server session was then
interrupted with `resume=false`, its late outputs preserved outside the repo,
the reviewed test restored, and `npm rebuild ffmpeg-static` restored the locked
dependency's binary. Focused failures and the entire suite subsequently pass.
No assertion was skipped or relaxed to hide these failures.

### Delegation and review

Requested CLIs were used through their platform-specific delegate skills:
agy/Gemini audited docs; OpenCode free models audited packaging and authored
the docs test; Grok audited authorization/media and implemented the image helper
and its tests. The orchestrator reviewed/reconciled the source, implemented the
shared safety and provider integration, ran every gate and made the commits.
Implementers ran no tests/builds. A later optional agy security review timed out;
there is no claim of a completed independent clean review.

### Privacy, compatibility and approval handoff

`PRIVACY.md` records the natural-language image path, selected speech provider,
transcript-to-chat/history flow, and local docs retrieval. No secret, user memory
or arbitrary file is indexed. No consent record, pairing, vault key or backup
format changes. The bundled Privacy Notice already covers configured AI context,
media, speech services and provider costs and was not changed in this phase.

The new `pt-BR`/`es-419` text is marked **draft**, with targeted ChatGPT Q-19 approval now recorded for the new Phase 06 strings
only (owner confirmed 2026-11-06). Older or otherwise unreviewed strings remain
draft. There is no blanket locale or native-speaker certification. Gateway
digests were refreshed without changing their existing draft review scope.

Before merge: owner review of #134 and review of final-head CI on the official
Node patch/platform matrix. The targeted Phase 06 Q-19 review is approved;
remaining draft scope is retained in `i18n/review.json`. Android and
live-provider behavior remain manual QA limits; a device pairing needs the
owner's authorization. Before a later Play release, reconcile the updated
Data safety mapping in Play Console. No Play form was changed here.

Rollback is a revert of the Phase 06 commits; no stored-data migration needs
undoing. Keep caller authorization and the Phase 05 router. No merge, tag,
release, Play upload or push to `main` was performed. Phase 07 has not started
and waits for the owner's approval.

## Final review plan (2026-11-06, before corrective application edits)

Trace media deadlines through the CommonJS/ESM send helper, command reply
proxy and socket media preparation. Reproduce cancellation while generating,
waiting for cooldown/typing, and preparing the final send with deterministic
mocks; also cover refusal, rejected sends, non-cancellable providers and repeated
requests. Propagate an optional AbortSignal to the final socket boundary and
remove unsafe raw-send retries if confirmed. Ordinary commands without a signal
retain their successful send behavior. An already initiated send cannot be
retracted by this cancellation contract.

Files expected: `src/services/aiTools.cjs`, `src/utils/sendBotMessage.cjs`,
`src/utils/sendBotMessage.esm.js`, `src/handlers/command.handler.js`,
`src/core/socket.js`, focused regression tests, `i18n/review.json`, this report
and tool-contract documentation. No migration, permission widening, new provider,
website retrieval, media archive or live endpoint test. Read-only delegates audit
remaining media/auth and documentation boundaries; the orchestrator verifies
findings and runs all gates. Rollback is reverting the corrective commit with
its regression tests, or reverting all Phase 06 commits for a full rollback.

The owner confirms ChatGPT completed the targeted Q-19 semantic review of new
Phase 06 `pt-BR` and `es-419` text in `bot/ai.json` and `commands.json`, with no
material errors. Record that scope while retaining draft status for older or
otherwise unreviewed strings; no blanket or native-speaker certification.

### Confirmed final-review findings and corrections

1. **Late media send after expiry (confirmed).** The original media code checked
   cancellation before calling the send helper, which then waited for cooldown
   without the signal. Socket media/thumbnail preparation added another async
   gap. Propagate the signal from `speak`/`generate_image`, make cooldown/typing
   waits abortable, preserve it through the reply proxy (including refusal
   notices and edits), and check it immediately before Baileys is invoked.
   The socket consumes the signal rather than passing it to Baileys. No await
   separates the final cancellation check and the send invocation.
2. **Unsafe CommonJS retry (confirmed).** Both CommonJS helpers retried an
   import/send error as a raw send, dropping safety metadata and potentially
   duplicating delivery. Errors now propagate, including failed ESM imports;
   refused results remain refusals. Ordinary successful calls without signals
   keep their quoting, typing, cooldown and routing behavior.
3. **Repeated tool IDs during provider switch (confirmed).** Canonical Gemini
   history has id-less tool calls. Name-to-single-ID maps paired repeated calls
   to the last ID when replayed to OpenAI/Anthropic. Per-name pending ID queues
   now consume results in order, or by exact explicit ID for reordered results.
   Tests cover repeated docs calls, other interleaved tools, multiple rounds,
   and Gemini/explicit/mixed IDs on both adapters.
4. **Open-section integration coverage (gap closed).** The three provider-wire
   fixtures now execute `open_levix_doc_section` after search and verify bounded
   untrusted text, the actual requested source ID and its backend citation.

The original cancellation regression suite failed 14 checks before application
changes (21 passed); it now passes 44 checks. This uses fake timers, deferred
providers and socket preparation, and fake Baileys only. It covers generation
expiry, cooldown/typing expiry, cancellation immediately before a send,
providers ignoring cancellation, busy/repeated calls, refusal/rejection, import
failure, an edit fallback, and the complete dispatcher/socket path. A send
already initiated is not necessarily retractable; cancellation only prohibits
initiating a new WhatsApp message after cancellation. Non-cancellable provider
or thumbnail work can finish locally, while the sender remains busy until
that work settles. No live account or paid provider was invoked.

Read-only agy/Gemini independently identified the cancellation/fallback gaps;
OpenCode GLM free identified the repeated-ID defect and the open-section test
gap. The orchestrator reproduced, reviewed and corrected them and runs all
checks. Grok's read-only audit timed out without a substantive final review;
no clean Grok review is claimed. No delegate made application edits or ran gates.
The orchestrator also audited real-sender permissions, backing-command disabled
checks/overrides, source-sensitive routing, selected-provider failure behavior,
image/audio validation, quotas, temp-file cleanup, invoking/quoted audio binding,
argument filtering, prompt/data separation and bundled-docs bounds/integrity.
No additional confirmed security defect or default permission widening was found.

Q-19 approval covers `aiTools.searchDocs`, `aiTools.openDoc` in `bot/ai.json`,
and the updated `gemini.description` in `commands.json`, for `pt-BR` and
`es-419` only. The owner reports ChatGPT found no material semantic errors.
Current file digests are recorded; older/unreviewed content stays draft. Q-18
is resolved with public repository documentation only, with no website retrieval.

Final gates will be recorded below against the corrective implementation commit
and rerun on the final documentation commit. Local tools/cache only applies to
all new validation: npm runs offline, an external-network test guard is
preloaded, and the installed `/usr/bin/ffmpeg` supplies the tarball install's
FFmpeg binary. No new tool, dependency, runtime, artifact or model is downloaded.
