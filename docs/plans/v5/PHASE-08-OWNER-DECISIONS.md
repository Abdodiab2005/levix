# Phase 08 — owner decisions and legal-copy draft (2026-11-10)

Status: **OWNER-APPROVED PRODUCT REQUIREMENTS; IMPLEMENTATION PENDING**. This document is a decision record and a proposed legal-copy source for the Phase 08 integration. It does **not** describe currently shipped behavior. No billing product, verifier deployment, keys, RTDN resource or paid build has been activated. Do not merge legal text into the shipping bundled Terms or Privacy release until functionality, legal review, four-locale parity and an effective date are ready.

These decisions supersede the conflicting *proposals* in `PHASE-08-RESULTS.md` (notably D-08-6 and the blanket D-08-7 global-memory exclusion).

## Approved requirements

### 1. Global AI memory: operator controls in Free and Plus

**Confirmed current risk:** normal `!ai` / `!gemini` requests automatically receive `global.md` in the system prompt by default; `gemini` and `memory` default to MEMBERS. AI can invoke `save_memory` while acting under an authorized bot-admin/owner caller without an extra owner confirmation. Do not describe global memory as manual-only.

- **Free AI:** provide an owner-operated setting for whether global memory may be **read** and a separate setting for whether the AI may **automatically write/change** global memory. Defaults should protect owner/private information: no global-memory exposure to ordinary callers by default; automatic writes OFF. Preserve explicit, authorized owner memory commands. Avoid trusting model claims of authority; enforce read and write policy server-side for the real verified caller and recheck at execution time.
- **Levix Plus Auto Reply:** offer a separate owner-operated, per-chat opt-in to **read** global memory, default OFF. Default OFF for any global-memory **write**. Never let arbitrary external senders alter shared memory just by prompting Auto Reply. If global writes are offered at all, require explicit owner authorization/approval of the action and design a guarded approval flow first. Enforce boundaries in prompt construction, tool calls, stored history and summarization; preserve account-epoch, sender authorization and final-send guards.
- Warn that enabling global-memory reading for a customer chat can cause private facts to influence or appear in responses. Avoid accidental cross-chat disclosure.
- Do not silently re-enable global memory for the owner or for newly added chats. Keep ordinary Free Core AI and Plus Auto Reply settings independent.
- Add tests for members/admins/owners, DMs/groups, global/all/Arabic/shared aliases, `save_memory`, `search_memory`, `forget_memory`, `summarize_chat`, historical transcripts, policy toggles and account changes.

### 2. Verification service hostname

- Use **`https://levix-plus.leviro.net`** (NOT `https://plus.leviro.net`) as the intended production verifier origin and in deployment documentation, configuration examples, and draft legal disclosures.
- No DNS, TLS, service account, secret, deployment or real provider connection has been authorized by this decision alone. Runtime should use a validated configurable HTTPS verifier origin, with production allowlisting/pinning as designed.

### 3. Backup: Plus customizations INCLUDED, subscription secrets EXCLUDED

- Include selected nonsecret Plus configurations in encrypted backup v1: custom bot messages/templates and locale overrides, presets, visibility preferences, and Auto Reply configuration (including its memory policy), subject to explicit allowlists and schema validation.
- Never export or restore purchase tokens, subscriptions/entitlement tokens, installation identity/private keys, high-water anti-rollback keys, verifier signing/sealing material, RTDN secrets, service credentials or other billing security data. Existing non-Plus backup behavior is not implicitly changed.
- Treat chat-linked Plus configurations as account-scoped: show them in preview; activate only for the original verified WhatsApp account, never for a mismatched/new account. Restoring configuration must **not** unlock Plus; apply it only when the separate entitlement is valid. Where a retained configuration references old chat IDs, keep it inactive until identity/scope checks pass.
- Update backup content manifest, create/restore tests, privacy and user-facing backup content descriptions. Remove prior draft copy claiming *all* Plus customizations are excluded.
- Preserve format-version compatibility and a safe migration/unknown-field policy. Avoid broad `ext:*` exports without a vetted key allowlist.

### 4. RTDN

- **Approved:** Google Play Real-time Developer Notifications via Google Cloud Pub/Sub with authenticated push/OIDC identity to the verifier, least-privilege service accounts, idempotent processing and follow-up verification against the Play Developer API.
- Implement the provisioning/deployment plan, but do not create real Google Cloud/Play resources or put secrets into a repository without separate owner authorization.

### 5. Subscription device-move policy and UI

- Policy: **one active installation per subscription, at most three changes of installation in a rolling 30-day period**. Maintain a carefully audited support exception procedure.
- Clearly state this material restriction in applicable Subscription Terms/Terms of Use available to the buyer **before purchase**. Keep a link to the relevant Terms accessible in the purchase flow. Do not obscure the restriction in the contract.
- **Do NOT display remaining moves, a move counter, or proactive messages like "you have N moves left"** in the application.
- When a move is denied, use a neutral actionable error explaining that the subscription cannot currently be moved and how to contact support; do not reveal internal counters.
- Avoid publishing any device-transfer history or individual subscription identifiers to other users.

### 6. Release gate for legal and privacy text

The current `PRIVACY.md` and bundled `src/legal/bundled/{en,ar,pt-BR,es-419}.json` describe shipped Free behavior. **Do not publish Plus as shipped before a paid build exists.** When Plus is prepared for live release, update Privacy, Terms and Google Play Data safety consistently, in all four locales; version/effective-date the legal bundle and ensure consent lifecycle checks/reviews pass.

## Proposed Terms of Use / subscription clause (English — DRAFT)

"Levix Plus is an optional paid subscription available through eligible official Android builds. Each subscription may be active on one installation at a time. You may move that subscription to another installation up to three times during any rolling 30-day period. Additional moves may be declined until the period permits another move. If you replace or reset your device, this may count as a move. Contact Leviro Support if you need an exception. Subscription purchase, renewal, cancellation and refunds are processed through Google Play subject to its applicable terms. Your Plus customizations are not proof of an active subscription and do not transfer purchase rights."

## مسودة بند شروط الاستخدام والاشتراك (العربية — للمراجعة)

"Levix Plus اشتراك مدفوع اختياري متاح في الإصدارات الرسمية المؤهلة من تطبيق Android. يمكن تفعيل الاشتراك على تثبيت واحد فقط في الوقت نفسه. يُسمح بنقل الاشتراك بين التثبيتات بحد أقصى ثلاث مرات خلال أي فترة متحركة مدتها 30 يومًا. قد تُرفض محاولات النقل الإضافية حتى تسمح المدة بنقلة جديدة. وقد تُحتسب إعادة ضبط الجهاز أو استبداله ضمن النقلات. يمكن التواصل مع دعم Leviro لطلب استثناء. تتم عمليات الشراء والتجديد والإلغاء والاسترداد من خلال Google Play وفقًا للشروط المعمول بها. الاحتفاظ بتخصيصات Plus أو استعادتها من نسخة احتياطية لا يعني نقل الترخيص أو إثبات صلاحية الاشتراك."

## Proposed Privacy Notice supplement (English — DRAFT)

"When you choose to purchase, restore or verify Levix Plus, Google Play processes your purchase. Levix sends the purchase token, app/package and product identifiers, a pseudonymous installation identifier and its public key, and signed request metadata to Leviro's subscription-verification service at https://levix-plus.leviro.net. The service verifies purchase and subscription status with Google Play and receives authenticated Google Play real-time subscription notifications through Google Cloud Pub/Sub. It records subscription state, expiry, acknowledgement and installation-binding/move history to prevent fraud and enforce the subscription's device policy. It does not need WhatsApp messages or chat contents to verify a purchase. Your encrypted local Levix backups may include Plus interface and automation customizations, but exclude purchase tokens, entitlement credentials and installation private keys. Restoring a backup does not activate Plus: access is reverified separately."

## مسودة ملحق إشعار الخصوصية (العربية — للمراجعة)

"عندما تختار شراء Levix Plus أو استعادة الاشتراك أو التحقق منه، تعالج Google Play عملية الشراء. ويرسل Levix رمز إثبات الشراء ومعرّفات التطبيق والمنتج ومعرّف تثبيت مستعارًا ومفتاحه العام وبيانات طلب موقّعة إلى خدمة التحقق من الاشتراك التابعة لـ Leviro على https://levix-plus.leviro.net. تتحقق الخدمة من حالة الشراء والاشتراك عبر Google Play، وتتلقى إشعارات حالة الاشتراك الموثّقة عبر Google Cloud Pub/Sub. وتحتفظ بحالة الاشتراك وتاريخ انتهائه وإقرار الشراء وسجل ربط الاشتراك بالتثبيتات ونقلاته للتحقق من الأحقية ومنع إساءة الاستخدام. ولا تحتاج الخدمة إلى رسائل WhatsApp أو محتوى المحادثات للتحقق من الشراء. يمكن أن تتضمن النسخ الاحتياطية المحلية المشفرة تخصيصات الواجهة والأتمتة الخاصة بـ Plus، لكنها لا تتضمن رموز الشراء أو بيانات إثبات الاشتراك أو مفاتيح التثبيت الخاصة. استعادة النسخة الاحتياطية لا تفعّل Plus تلقائيًا؛ إذ يجب التحقق من الاشتراك بصورة مستقلة."

Both drafts need review against actual deployed processing, Google Play policies, retention/deletion arrangements, and consumer-protection requirements before release. Translate and native-review pt-BR/es-419 without marking machine drafts as certified.

## Next implementation deliverables

1. Free and Plus memory-policy controls with auth tests and privacy-regression tests.
2. Backup allowlist for nonsecret Plus customizations, same-account restore gating, preview and compatible format tests.
3. Config/docs using `levix-plus.leviro.net`.
4. RTDN provisioning instructions and eventual live verification, separate from code merging.
5. Terms/Privacy translation updates in four locales and Play Data Safety changes **at billing release time**; no move counter UI.
6. Update `PHASE-08-RESULTS.md` decisions/status once implementation PRs exist. Re-run CI and private Core interop on the final heads.

No merges, deployments, policy-effective-date changes, signing keys or production billing configuration in this documentation PR.
