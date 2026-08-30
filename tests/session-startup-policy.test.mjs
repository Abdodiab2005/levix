import {
  hasPairedCredentials,
  sessionStartupPolicy,
} from "../src/bootstrap/session-startup-policy.js";
import { section, equal, finish } from "./harness.mjs";

section("paired credential detection");

equal("no creds are unpaired", hasPairedCredentials(null), false);
equal("an empty creds row is unpaired", hasPairedCredentials("{}"), false);
equal(
  "a pre-pairing creds row is still unpaired",
  hasPairedCredentials(JSON.stringify({ noiseKey: { private: "x" } })),
  false
);
equal("malformed creds fail closed", hasPairedCredentials("{not-json"), false);
equal(
  "creds.me.id proves a completed pairing",
  hasPairedCredentials(JSON.stringify({ me: { id: "201234567890:1@s.whatsapp.net" } })),
  true
);
equal(
  "already-parsed credentials are accepted too",
  hasPairedCredentials({ me: { id: "201234567890:1@s.whatsapp.net" } }),
  true
);

section("session startup policy");

let policy = sessionStartupPolicy({ autoStart: false, wasPaired: false });
equal("a fresh panel install stays idle", policy.start, false);
equal("a fresh panel install has no startup reason", policy.reason, null);

policy = sessionStartupPolicy({ autoStart: false, wasPaired: true });
equal("a paired panel install resumes after process restart", policy.start, true);
equal("a paired panel install records the resume reason", policy.reason, "resume-paired");

policy = sessionStartupPolicy({ autoStart: true, wasPaired: false });
equal("headless forces a start even before pairing", policy.start, true);
equal("headless keeps the autostart reason", policy.reason, "autostart");

policy = sessionStartupPolicy({ autoStart: true, wasPaired: true });
equal("headless still starts an already-paired install", policy.start, true);
equal("explicit autostart wins over resume-paired", policy.reason, "autostart");

finish();
