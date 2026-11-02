# Legal copy review (Phase 04)

Status: PENDING HUMAN LEGAL REVIEW. No lawyer has reviewed the text. The bundled Terms of Use and
Privacy Notice (`src/legal/bundled/*.json`, version `2026-11-02.1`) are drafts. A machine review on
2026-11-02 (section 3) found factual errors. Those errors are fixed in commit 1d34a86 on PR #127.
No obligation, disclaimer, liability limit or consent rule changed. Every legal question that
review raised is open (section 7).

Any text change after a release needs a new `version`. The content hash changes, so every
installation is asked to accept again (ADR-020). Version `2026-11-02.1` accompanies the full
policy correction and adds the approved Caddy-installation disclosure to the notices.

## 1. Required points and where the draft covers them

| Requirement (Phase 04 prompt) | Section | Note for the reviewer |
| --- | --- | --- |
| Risk of a WhatsApp account ban | Terms 2.2 | WhatsApp or Meta can limit, suspend or ban an account without warning; the developer cannot reverse it. |
| Not affiliated with WhatsApp or Meta | Terms 2.1 | Names an unofficial protocol implementation, not Baileys. |
| The user's obligations | Terms 3 | Lawful use, no spam or bulk messages, a lawful basis for processing other people's messages, credential security. |
| Limitation of liability, only as far as the law allows | Terms 6 | A limitation paragraph, then a carve-out for laws and consumer rights that cannot be waived. |
| No claim that no data leaves the device | Privacy 2 and 3 | WhatsApp, the AI provider, Google Search grounding (on by default), other feature services, model discovery, the `levix domain` IP lookup, the proxy, and the developer-bound flows. |
| MIT licence stays intact | Terms 1.2 | The terms do not limit the licence. They apply to the official builds and the developer's services. |
| Consent lifecycle (ADR-020) | Terms 1.3, 7.1 | Once per installation; again after a document change or an app update; kept through unlink, account change, reconnect, restart and password reset; a live connection stays open; a dropped one waits for acceptance. |
| The acceptance record stays local | Privacy 4 | Matches `LEGAL_CONSENT_CONTRACT.md` section 3, including `via` and the pre-upgrade database copy. |

## 2. Cross-check with `PRIVACY.md`

| `PRIVACY.md` flow | In the notice | Gap after commit 1d34a86 |
| --- | --- | --- |
| WhatsApp (Meta) | Privacy 2.1 | none |
| AI provider, its context and media | Privacy 2.2 | none |
| Gemini Google Search grounding, on by default | Privacy 2.2 | none (was: default not stated) |
| DuckDuckGo or Google Programmable Search, Wikipedia, pages the AI opens | Privacy 2.3 | provider names only in the full policy |
| Google Cloud Translation, the public Translate endpoint, Google TTS | Privacy 2.3 | none |
| OpenWeatherMap, Aladhan, is.gd and v.gd | Privacy 2.3 | provider names only in the full policy |
| AI provider models endpoint during model discovery | Privacy 2.3 | none (was: not named) |
| `api.ipify.org` during `levix domain` | Privacy 2.3 | provider name only in the full policy |
| Link previews and remote thumbnails, off by default | Privacy 2.3 | see section 4, item 3 |
| Outbound proxy | Privacy 2.4 | none |
| Feedback to Leviro Support through Telegram, optional diagnostics and debug log | Privacy 3.1 | none (was: Telegram and payload fields not named) |
| Crash reports, sent only on Send, kept 30 days | Privacy 3.1, 5.2 | retention only in the full policy |
| Recovery mail relay, keyed hashes only | Privacy 3.1 | none (was: reset request trigger understated) |
| Sticker upload to the user's own Levix instance | not named | stays on the user's own server |
| Dashboard fonts | no outbound request | The existing fonts are bundled locally. |
| Caddy package sources | Privacy 2.3 | `PRIVACY.md` names Cloudsmith and system repositories. |

## 3. Machine review, 2026-11-02

Reviewer: Antigravity (Claude Sonnet 5.5), read-only, against `PRIVACY.md`, the contract, ADR-019,
ADR-020 and the code. Result: 36 findings, 1 BLOCKER, 15 MAJOR, 20 MINOR. This is not a legal
review.

Fixed in commit 1d34a86 (factual text only, all four locales):

| Finding | Was | Now |
| --- | --- | --- |
| BLOCKER, privacy 5.1 | "uninstall Levix to remove its data" for every platform | Android uninstall; elsewhere the folder `levix where` prints or the Docker volume |
| privacy 2.2 | Google Search grounding default not stated | on by default for Gemini, can be turned off |
| privacy 3.1 | feedback "reaches the developer" | fields listed; delivered through Telegram, which stores it; crash report contents; reset codes can be requested from the login page |
| privacy 5.2 | "how long it is kept" for every destination | retention for the data the developer keeps |
| privacy 2.3 | list read as complete; AI queries read as user-run | AI search queries come from chats; model discovery and the IP lookup named |
| privacy 4.1 | no `via`; "not in backups" | `via` named; "not in Settings backups or exports"; the pre-upgrade copy keeps it; "SHA-256 hash" for "fingerprint" |
| privacy 5.1 | no route to delete developer-held data | ask Leviro Support to delete sent feedback or crash reports |
| terms 1.3, 7.1 | lifecycle incomplete | what keeps the acceptance; a dropped connection stays offline until acceptance |
| terms 4.1 | "you pay their costs" for every service | only services that need an account or API key |
| terms 7.2 | "Settings, then Feedback" | "Settings, then Feedback & Support" (the real tab) |
| ar terms 2.2, 2.3 | "يجوز" (a right) | "بإمكان" (a possibility) |
| pt-BR terms 3.2 | "falsidade de identidade" (a criminal-law term) | "se passar por outra pessoa" |

Not changed, because the fix is a legal or product decision:

- Terms 7.1 and `PRIVACY.md` section 8 now describe explicit acceptance; the owner approved this
  correction on 2026-11-02.
- An edit to `PRIVACY.md` alone never asks for a new acceptance, because only the bundled
  documents are hashed. The reviewer should confirm that the short notice, not the linked policy,
  is the accepted text.
- Terms 1.2 scopes the terms to "official Levix builds". The gate runs in every build, forks
  included.
- No translation states that the English text prevails, and the English text does not claim it.

## 4. Gaps outside the notice text

1. Dashboard and gateway fonts are now self-hosted, as the owner approved.
2. The notice and policy now disclose approved Caddy installation package requests.
3. The policy now distinguishes sending remote media from optional thumbnail downloads.

## 5. Changes that need a new document version later

| Change | Phase | Text to add |
| --- | --- | --- |
| Remote Terms fetch from `levix.leviro.net` (no identifier, no body), when the owner turns it on | 04c | Privacy 3: the app downloads the current Terms; the request carries no identifier. |
| Google Play Billing for Levix Plus | 08 | Privacy: purchase and entitlement data handled by Google Play and the Leviro verification service. Terms: subscription terms. |
| Update checks against GitHub Releases or Google Play | 09 | Privacy 2: version checks and what they send. |
| Any new outbound destination | any | `PRIVACY.md` row first, then the notice, then a new version. |

## 6. Translations and Google Play

- `ar`, `pt-BR` and `es-419` are machine translations (Antigravity, Claude Sonnet 5.5). ChatGPT
  reviewed the Portuguese and Spanish documents against English on 2026-11-02 and corrected a
  Spanish consent sentence. The new Caddy sentences also received machine review. This is not
  native-speaker certification or legal approval; the Arabic addition still needs language review.
- Google Play Data safety: the consent record stays on the device and is never collected or
  shared, so it needs no Data safety change. No Play Console change has been made.

## 7. Questions for the legal reviewer

1. Terms 6.1 excludes account, message, data, profit and business loss with no cap and no
   carve-out for intent, gross negligence or personal injury. Is "to the extent permitted by law"
   enough in Egypt (Civil Code art. 217), Brazil (CDC art. 51), the EU and Latin America, or must
   those carve-outs be named? Do Brazilian adhesion-contract rules (CDC art. 54 §4) require the
   limiting clauses to be conspicuous?
2. Terms 5 ("as is", no warranty): does it collide with mandatory conformity rules (Brazil CDC,
   EU Directive 2019/770, Egypt Law 181/2018) for free software that also sends feedback and crash
   data?
3. Terms 1.1 names "Abdelrhman Diab (Leviro)". Who is the contracting party, and in what capacity?
4. Terms 7.1: is withholding the WhatsApp connection until acceptance fair under unfair-terms
   rules (EU 93/13, CDC art. 51)?
5. Is typing `accept` in a terminal, or the provisioning command run by an installer or a Docker
   entrypoint, adequate evidence of consent? Who is the operator when someone else's account is
   linked?
6. Terms 2.2 ("Do not link an account you cannot afford to lose"): does it read as advice the
   developer could be held to, or as an admission that combines with Terms 6.1 to waive the most
   foreseeable loss?
7. Terms 1.2: is the MIT statement consistent with conditions on "official builds", and with the
   extra disclaimers in Terms 5 and 6? There is no trademark clause.
8. Terms 3.2 and 3.3 make the operator responsible for a lawful basis. Do chat participants,
   whose text reaches AI providers and Google, need their own notice? Does Egypt PDPL (Law
   151/2020) apply to a group-moderating bot?
9. The notice has no controller identity, legal bases, international-transfer statement,
   data-subject rights, retention periods or privacy contact. Is the short notice plus the linked
   `PRIVACY.md` enough for GDPR arts. 13 and 14, LGPD art. 9 and Egypt PDPL?
10. There is no minimum-age clause in the Terms; `PRIVACY.md` says 16 and over. Add one (LGPD
    art. 14, Play policy)?
11. "Incidental", "consequential" and "as is" are common-law terms. Do their Arabic, Portuguese
    and Spanish renderings map to the civil-law categories, and which language governs?
12. Can the developer disclaim responsibility for Telegram, a processor the developer chose for
    feedback (Terms 4.1)?
13. Is the acceptance record personal data, and is its retention stated well enough?
14. Should the Terms name a governing law or a dispute forum, or stay silent?
