# Levix Plus Legal Drafts

> **DRAFT. Not effective. Not shipped. Machine translation for ar, pt-BR, es-419. No human legal review.**

---

## 1. Release Gate

The documents in this directory are non-binding drafts for the optional **Levix Plus** paid subscription on Android. They are not active in any shipped build.

These texts may enter official distribution files (`src/legal/bundled/*`, `PRIVACY.md`, and the Google Play Data safety declaration) only when all of the following release gate requirements are satisfied:

1. **Paid-build release:** The drafts apply exclusively to official paid Android builds distributed via Google Play. Public Free builds, desktop builds, Docker containers, npm packages, and SEA binaries do not bundle or ship these texts.
2. **New effective date:** A formal release effective date must be assigned at publication time.
3. **Four-locale parity:** Identical legal substance and structure must be preserved across all four supported locales: English (`en`), Modern Standard Arabic (`ar`), Brazilian Portuguese (`pt-BR`), and Latin American Spanish (`es-419`).
4. **Human legal review:** Qualified legal counsel must review and approve all terms and privacy notices before publication.
5. **Terms consent lifecycle:** Per ADR-006, ADR-019, and ADR-020, any modification to bundled Terms or Privacy terms constitutes a document version or hash bump that triggers mandatory re-consent across installations before the WhatsApp socket opens (`#open()`).

---

## 2. File Inventory

| File | Type | Locale | Description |
| --- | --- | --- | --- |
| `README.md` | Overview | English | Status banner, release gates, and file inventory |
| `plus-terms.en.md` | Terms section | `en` | "Levix Plus subscription" section draft in English |
| `plus-terms.ar.md` | Terms section | `ar` | "Levix Plus subscription" section draft in Modern Standard Arabic |
| `plus-terms.pt-BR.md` | Terms section | `pt-BR` | "Levix Plus subscription" section draft in Brazilian Portuguese |
| `plus-terms.es-419.md` | Terms section | `es-419` | "Levix Plus subscription" section draft in Latin American Spanish |
| `plus-privacy.en.md` | Privacy supplement | `en` | "Levix Plus" privacy supplement draft in English |
| `plus-privacy.ar.md` | Privacy supplement | `ar` | "Levix Plus" privacy supplement draft in Modern Standard Arabic |
| `plus-privacy.pt-BR.md` | Privacy supplement | `pt-BR` | "Levix Plus" privacy supplement draft in Brazilian Portuguese |
| `plus-privacy.es-419.md` | Privacy supplement | `es-419` | "Levix Plus" privacy supplement draft in Latin American Spanish |
| `plus-data-safety.md` | Data safety mapping | `en` | Google Play Data safety delta table and definitions for the paid build |
