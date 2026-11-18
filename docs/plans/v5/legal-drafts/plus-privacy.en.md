# Levix Plus Privacy Supplement

This document describes the data processing practices for the optional **Levix Plus** subscription on Android builds of Levix.

---

## 1. Overview and Purposes

Levix Plus is an optional paid subscription. The verification service operated by Leviro at `https://levix-plus.leviro.net` collects and processes limited subscription and installation metadata solely for the following purposes:
- Verifying purchases and active subscription status with Google Play.
- Enforcing the subscription installation policy (one active installation at a time, up to three installation moves per rolling 30-day period).
- Preventing fraud and abuse.

Levix Plus involves **no advertising**, no tracking across third-party apps, and **no sale of user data**.

---

## 2. Data Sent Off the Device

When you choose to purchase, restore or verify Levix Plus, or when the app automatically refreshes its subscription entitlement, the app sends a verification request directly to `https://levix-plus.leviro.net`.

The request contains:
- The Google Play purchase token.
- The Android package name and product identifier.
- A pseudonymous installation identifier (a SHA-256 hash of an installation public key generated on the device).
- The installation public key itself (Ed25519).
- A request nonce.
- A client timestamp.
- A monotonic request sequence number.
- An Ed25519 cryptographic signature generated over the request payload using the device's installation private key.

**What is never sent:** Levix Plus never transmits WhatsApp messages, chat content, participant identifiers, contacts, or phone numbers to the verification service.

---

## 3. Google Play Processing and Real-Time Notifications

- Google Play processes subscription purchases, renewals, cancellations, and refunds under Google's applicable terms and privacy policies.
- The verification service queries Google Play's Developer API to confirm subscription purchase state, expiration dates, and acknowledgement status.
- The verification service receives authenticated Google Play Real-time Developer Notifications (RTDN) through Google Cloud Pub/Sub to react to subscription renewals, cancellations, grace periods, and refunds.

---

## 4. Data Stored by the Verification Service

The verification service stores the following records:
- A SHA-256 hash of the purchase token, and the purchase token itself encrypted at rest using AES-256-GCM with a service key.
- Subscription metadata: package name, product identifier, Google Play subscription state, expiration timestamp, acknowledgement state, test purchase flag, and initial binding and check timestamps.
- Installation binding records: installation public key, sequence counter, and registration/refresh timestamps.
- Installation move history: timestamps and associated installation identifiers for device transfers.
- Google Cloud Pub/Sub notification message identifiers.

---

## 5. Retention Periods and Logging Safeguards

- **Request nonces:** Retained for 10 minutes to prevent replay attacks, then automatically purged.
- **Pub/Sub message IDs:** Retained for 7 days to deduplicate incoming Google Play notifications, then purged.
- **Purchases and move history:** Deleted 90 days after Google Play subscription expiration.
- **Installation records:** Kept while the verification service runs.
- **Server backups:** Follow the service operator's standard backup retention schedule.
- **Logging safeguards:** The verification service never logs purchase tokens, request signatures, private keys, or raw request bodies. IP addresses are used solely for transient, in-memory rate limiting.

---

## 6. Data Stored Locally on the Device

- The installation private key and the cryptographically signed entitlement token returned by the verification service are stored sealed (encrypted with AES-256-GCM) in the local Levix database.
- The installation private key and signed entitlement token are **never** included in settings exports, pre-migration database copies, or exported user backups, and are **never** uploaded anywhere (only the corresponding public key is transmitted to the verification service).

---

## 7. Backups and Restore

- Local encrypted Levix backups (created via Settings > Backup with an operator passphrase) may include Plus customizations: customized bot messages and their translations, presets, visibility preferences, and Auto Reply rules (including per-chat global memory settings).
- Restoring a backup **never** activates Levix Plus; entitlement status is always verified afresh with the verification service.
- Auto Reply rules are restored only when the same WhatsApp account is linked.

---

## 8. Auto Reply and AI Features

- When an Auto Reply rule triggers, the bot sends message text and conversation context to the AI provider configured by the operator, under the exact same terms, configurations, and privacy boundaries as the Free AI feature.
- Global long-term memory is used in an Auto Reply conversation only when the operator explicitly enables global memory for that specific chat; otherwise, memory access is strictly scoped to that individual chat.

---

## 9. Data Deletion Requests

- You may request deletion of verification service records associated with your purchase by contacting Leviro Support through in-app **Settings > Feedback**.
- Google Play maintains its own financial transaction and purchase history records subject to Google's data retention policies.
