# Legal copy review (Phase 04)

Status: PENDING REVIEW. The bundled English Terms of Use and Privacy Notice
(`src/legal/bundled/en.json`, version `2026-11-02`) are a draft written for Phase 04a. They need a
human legal review before v5.0.0 ships. Any text change after this review needs a new `version`,
because the content hash changes and every installation is asked to accept again (ADR-020).

## 1. Required points and where the draft covers them

| Requirement (Phase 04 prompt) | Draft section | Note for the reviewer |
| --- | --- | --- |
| Risk of a WhatsApp account ban | Terms 2, paragraph 2 | States that WhatsApp or Meta can limit, suspend or ban an account without warning, and that the developer cannot reverse it. |
| Not affiliated with WhatsApp or Meta | Terms 2, paragraph 1 | Names the unofficial protocol implementation without naming Baileys. |
| The user's obligations | Terms 3 | Lawful use, no spam or bulk messages, a lawful basis for processing other people's messages, credential security. |
| Limitation of liability, only as far as the law allows | Terms 6 | Two paragraphs: the limitation, then a carve-out for laws and consumer rights that cannot be waived. |
| No claim that no data leaves the device | Privacy 2 and 3 | Lists WhatsApp, the AI provider, Google Search grounding, other feature services, the proxy, and the three developer-bound flows. |
| MIT licence stays intact | Terms 1, paragraph 2 | Says the terms do not limit the licence and apply to the official builds and the developer's services. |
| Consent lifecycle (ADR-020) | Terms 1, paragraph 3; Terms 7 | Once per installation; asked again after a document change or an app update; a live connection stays open. |
| The acceptance record stays local | Privacy 4 | Matches `LEGAL_CONSENT_CONTRACT.md` section 3. |

## 2. Cross-check with `PRIVACY.md` (main 407bf1e)

| `PRIVACY.md` flow | In the notice | Gap |
| --- | --- | --- |
| WhatsApp (Meta) | Privacy 2 | none |
| AI provider, its context and media | Privacy 2 | none |
| Gemini Google Search grounding, on by default, can be turned off | Privacy 2 | none |
| DuckDuckGo or Google Programmable Search, Wikipedia, pages the AI opens | Privacy 2, "web search, Wikipedia and pages the AI opens" | provider names only in the full policy |
| Google Cloud Translation and the public Translate endpoint, Google TTS | Privacy 2 | none |
| OpenWeatherMap, Aladhan, is.gd and v.gd | Privacy 2, "weather, prayer times and link shorteners" | provider names only in the full policy |
| Link previews and remote thumbnails, off by default | Privacy 2 | none |
| AI provider models endpoint during model discovery | not named | covered by "the AI provider you configured"; reviewer to confirm |
| `api.ipify.org` during `levix domain` (desktop and server only) | not named | the notice points to the full policy for every destination |
| Outbound proxy | Privacy 2 | none |
| Feedback to Leviro Support, delivered through Telegram, optional diagnostics and debug log | Privacy 3 | Telegram delivery named only in the full policy |
| Crash reports, sent only on Send, kept 30 days | Privacy 3 | retention named only in the full policy |
| Recovery mail relay, keyed hashes only | Privacy 3 | none |
| Sticker upload to the user's own Levix instance | not named | stays on the user's own server; reviewer to confirm no mention is needed |

## 3. Changes that need a new document version later

| Change | Phase | Text to add |
| --- | --- | --- |
| Remote Terms fetch from `levix.leviro.net` (no identifier, no body) | 04c | Privacy 3: the app downloads the current Terms; the request carries no identifier. |
| Google Play Billing for Levix Plus | 08 | Privacy: purchase and entitlement data handled by Google Play and the Leviro verification service. Terms: subscription terms. |
| Update checks against GitHub Releases or Google Play | 09 | Privacy 2: version checks and what they send. |
| Any new outbound destination | any | `PRIVACY.md` row first, then the notice, then a new version. |

## 4. Translations

`ar`, `pt-BR` and `es-419` versions are planned in 04b. English is the reference text. Each
translation states that the English text prevails if they differ, if the reviewer agrees. ChatGPT
reviews `pt-BR` and `es-419` (Q-19); that is a language review, not a legal review.

## 5. Google Play Data safety

The consent record stays on the device and is never collected or shared, so it needs no Data safety
change. The remote Terms fetch in 04c sends no user data; the review of that answer happens in 04e,
after the fetch ships. No Play Console change has been made.

## 6. Questions for the legal reviewer

1. Is "to the extent permitted by the law that applies to you" enough for users in Egypt, the EU,
   Brazil and Latin America, or does any of them need a named consumer-law carve-out?
2. Does the MIT licence statement in Terms 1 conflict with any clause that restricts use of the
   official builds?
3. Is acceptance by typing `accept` in a terminal, or by a provisioning command run by the
   operator, adequate evidence of consent for an unattended server install?
4. Should the Terms name a governing law or a dispute forum, or stay silent as the draft does?
5. Does the instruction "do not link an account you cannot afford to lose" read as advice the
   developer could be held to?
