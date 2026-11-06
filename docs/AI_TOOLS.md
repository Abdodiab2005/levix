# AI documentation and media tools

The same declarations are offered to Gemini, OpenAI-compatible and Anthropic
chat providers. The selected chat provider stays unchanged. Examples are in
the command catalog and README; an AI action still requires an AI command.

| Tool | Arguments | Successful result and authority |
| --- | --- | --- |
| `search_levix_docs` | `query` (1–300 characters), optional `language` (`ar`, `en`, `pt-BR`, `es-419`), `limit` (1–5, default 3) | Up to five public excerpts, source IDs, section titles, version, language/fallback and citations. Read-only, no network. |
| `open_levix_doc_section` | Exact `id` from search | At most 4000 characters from that bundled section; no path or URL lookup. |
| `generate_image` | `prompt` (1–3000 characters) | Sends one validated PNG/JPEG/WebP; reports actual provider/model/MIME only after accepted delivery. Checks the live `gemini` permission and enabled state, like its alias `!generate`. |
| `speak` | `text` (1–3000 characters), optional speech `language` | Reuses `!tts`; sends OGG/Opus PTT, or an MP3 attachment when FFmpeg is unavailable. Checks `tts`. |
| `transcribe_audio` | None | Reuses `!stt`; returns a transcript of up to 12000 characters as untrusted tool data. Checks `stt` and `ai_stt_enabled`. |

The docs index includes only README, SETUP, ANDROID, PRIVACY and the four
command catalogs. `npm run docs:build` regenerates it; `npm run docs:check`
rejects source or package-version drift. Source SHA-256 digests and stable
section IDs are committed with the index. English prose is an explicit fallback
for multilingual queries; command reference entries exist in all four locales.
Search is lexical with a small multilingual topic bridge, not an embedding
service. A missing match is missing evidence. Planning documents, agent rules,
memories, secrets, operator settings and arbitrary files never enter the index.

Documentation and transcripts remain tool results, never system instructions
or permission grants. The backend attaches citations only for section IDs
that exist in the bundled index. No new deep website URLs are guessed; official
product links remain in the code-owned AI identity.

Media tools act for the sender minted from the invoking WhatsApp message.
Audio is snapshotted privately at that boundary: direct audio first, otherwise
quoted audio, including wrapped messages. Tool arguments cannot select an
author, chat, media URL or message from history. Ordinary AI turns download
audio only when the authorized transcription tool runs. The explicit `add` /
`send` batch keeps its existing upload behavior.

Model-initiated media shares a limit of three attempts per sender per minute
and one in-flight operation per sender. Audio and image bytes are capped at
8 MiB. The deadline follows `ai_tool_timeout_ms`, with a 120-second ceiling;
provider requests and FFmpeg also have their own deadlines. A timed-out
non-cancellable operation stays busy until it finishes and cannot send later.
The reply router still checks delivery; refusal is an error, never success or
a fallback to a different group. Shared explicit STT/TTS paths also enforce
their byte/text limits. General AI media downloads are capped at 64 MiB.

Images always use the dedicated Gemini image key, endpoint and model. TTS
uses Google TTS, without an AI API-key charge. STT uses Gemini or an
OpenAI-compatible transcription endpoint: explicit provider choices fail
closed on a missing key; `auto` retains the existing available-key fallback.
Images and STT may incur charges under the operator's provider account.
Quota, missing support, bad arguments, malformed/oversized media, timeout and
refused routing return errors; provider response bodies and credentials are
not returned by the media tools. There is no music or sound-effect generator.

Image bytes go to WhatsApp and are absent from tool results. For transcription,
the selected audio goes to the speech provider, and the transcript then goes
to the chat provider and can enter local AI history. Public retrieved excerpts
also join the current chat request. See [PRIVACY.md](../PRIVACY.md) for recipients
and retention. No live provider or WhatsApp account is needed by automated tests.
