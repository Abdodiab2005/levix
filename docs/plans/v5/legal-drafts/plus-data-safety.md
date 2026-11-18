# Google Play Data Safety Delta — Levix Paid Build

> **DRAFT. Proposed Google Play Data safety delta for official paid Android builds.**

This document defines the Google Play Data Safety declaration updates required exclusively for the official paid Android build of Levix (enabling Levix Plus).

**Important:** Free builds of Levix distributed from source or public release channels send **nothing new** and their Data Safety declarations remain completely **unchanged**.

---

## 1. Paid Build Data Safety Delta

The table below specifies the additional data types collected when an operator purchases, restores, or uses Levix Plus on Android.

Under Google Play's Data safety definitions:
- **Collection** includes transmission off the device to Leviro's verification service (`https://levix-plus.leviro.net`).
- **Sharing** does **not** include transmission to a service provider or infrastructure processor (such as Google Play Developer API or Google Cloud Pub/Sub) that processes data on the developer's behalf.
- **Optional vs. Required:** The data is **Optional** at the app level because Levix Plus is an optional subscription; it is **Required** to activate and use Levix Plus features once subscribed.

| Data Type (Play Category) | Collected? | Shared? | Purpose | Optional / Required | Encrypted in Transit? | Deletion Request? |
| --- | --- | --- | --- | --- | --- | --- |
| **Financial info** > **Purchase history** | **Yes** | **No** | App functionality, Fraud prevention / security / compliance | **Optional** (only if Plus is purchased/restored) | **Yes** (HTTPS) | **Yes** (via Leviro Support in Settings > Feedback; Play transactions retain per Google policy) |
| **Device or other IDs** > **Device or other IDs** | **Yes** | **No** | App functionality, Fraud prevention / security / compliance | **Optional** (only if Plus is purchased/restored) | **Yes** (HTTPS) | **Yes** (tied to purchase record deletion via Leviro Support) |

### Detailed Explanation of Declared Types

1. **Financial info > Purchase history:**
   - **What is collected:** Google Play purchase token, product ID, subscription purchase state, expiry timestamp, acknowledgement state, and test purchase flag.
   - **Why:** Verifying active subscription entitlement with Google Play and synchronizing Real-time Developer Notifications (RTDN).
   - **Recipient:** Leviro verification service (`https://levix-plus.leviro.net`) and Google Play Developer API.
   - **Retention:** Purged 90 days after Google Play subscription expiry.

2. **Device or other IDs > Device or other IDs:**
   - **What is collected:** A pseudonymous installation identifier (cryptographic SHA-256 hash of an on-device generated public key) and the Ed25519 public key itself.
   - **Why:** Enforcing the subscription installation move policy (one active installation at a time, up to three installation moves per rolling 30-day period) and verifying signed request payloads.
   - **What is excluded:** Does **not** collect Android ID, IMEI, MAC address, advertising ID, hardware serials, phone numbers, or WhatsApp JIDs.

---

## 2. Unchanged Free Build Declarations

All existing declarations established for the Free build in `PRIVACY.md` (Section 7) remain **fully unchanged** in the paid build:

| Data Type | Collected? | Shared? | Required? | Purpose | Status in Paid Build |
| --- | --- | --- | --- | --- | --- |
| Personal info > **Name** | Yes | No | Optional | App functionality | Unchanged |
| Personal info > **User IDs / personal identifiers** | Yes | No | Required | App functionality | Unchanged |
| Personal info > **Phone number** | Yes | No | Required | App functionality | Unchanged |
| Personal info > **Email address** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Location > **Approximate location** | Yes | No | Optional | App functionality | Unchanged |
| Messages > **Other in-app messages** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Photos and videos > **Photos** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Photos and videos > **Videos** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Audio files > **Voice or sound recordings** | Yes | No | Optional | App functionality | Unchanged |
| Audio files > **Other audio files** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Files and docs > **Files and docs** | Yes | No | Optional | App functionality, Customer support | Unchanged |
| Contacts > **Contacts** | Yes | No | Optional | App functionality | Unchanged |
| App activity > **In-app search history** | Yes | **Yes** | Optional | App functionality | Unchanged |
| App activity > **Other user-generated content** | Yes | **Yes** | Optional | App functionality | Unchanged |
| Web browsing > **Web browsing history** | Yes | **Yes** | Optional | App functionality | Unchanged |
| App info and performance > **Crash logs** | Yes | No | Optional | App functionality, Analytics | Unchanged |
| App info and performance > **Diagnostics** | Yes | No | Optional | App functionality, Analytics | Unchanged |

Free builds do not incorporate `levix-plus` code, do not contact `https://levix-plus.leviro.net`, and send none of the paid build data types.

---

## 3. Play Console Question Updates for Paid Build

- **Q: Does your app collect or share any of the required user data types?**
  - **Yes** (remains Yes).
- **Q: Is all of the user data collected by your app encrypted in transit?**
  - All communication between the app and `https://levix-plus.leviro.net` is encrypted in transit over HTTPS (HTTPS). App-wide answer remains subject to the final v5.0.0 transit audit.
- **Q: Do you provide a way for users to request that their data is deleted?**
  - For the **Paid build**: **Yes**. Users may submit a data deletion request for server-side verification records tied to their purchase via in-app **Settings > Feedback**. Records are also automatically purged 90 days after subscription expiration. Google Play retains purchase history records according to Google's standard billing retention policies.
  - For the **Free build**: Remains **No** (as Free Levix has no developer-operated accounts or server-side user data).
- **Account creation:**
  - **My app does not allow users to create an account** (remains unchanged).
