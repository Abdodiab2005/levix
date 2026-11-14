# Next-release development

> Historical source record for PR #168. The owner superseded its release
> restriction on 2026-11-13: 11A is ported separately into v5.0.0 under
> [ADR-021](../v5/DECISIONS.md#adr-021-include-existing-phase-11a-in-v500).
> Original test evidence below is not a test result for the port; see
> [port evidence](../v5/PHASE-11A-PORT.md).


This folder is outside the v5.0.0 release plan. The owner authorized Phase 11A
(connected WhatsApp account card) after Phase 09 became code-ready.

- Base branch: `next/5.1.0`, branched from code-ready Phase 09 plus its final
  evidence at `40051f6`.
- Feature branch: `feat/next-account-card`; PR must target `next/5.1.0`.
- Scope: `PHASE-11-PLAN.md`; evidence and limits: `PHASE-11-RESULTS.md`.
- No version bump, tag, merge, publication or deployment is authorized.

Phase 10 in `../v5/PHASES.md` remains the mandatory final audit and release gate
for v5.0.0. Phase 11 must never enter or delay that release.
