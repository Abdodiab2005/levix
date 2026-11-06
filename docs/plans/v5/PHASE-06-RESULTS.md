# Phase 06: documentation-aware AI and media tools

Date: 2026-11-06. Base: `release/5.0.0-beta.1` `a68696d` (Phase 05 merged in
`3aee413`). Branch: `feat/v5-phase-06`. Status: `IN PROGRESS`, not merged.
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

PENDING. No implementation or final validation is claimed by this plan.
