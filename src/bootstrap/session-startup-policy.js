// Decide whether the WhatsApp session should be started during process boot.
//
import linkedCreds from "../utils/linkedCreds.cjs";

// Baileys writes a `creds` row as soon as auth state is initialized, even before
// a QR is successfully paired, and `requestPairingCode` writes `creds.me.id`
// before the phone accepts the code. `isLinkedCreds` tells a finished link from
// those; the rules are in src/utils/linkedCreds.cjs.
export function hasPairedCredentials(rawCreds) {
  if (!rawCreds) return false;
  try {
    const creds = typeof rawCreds === "string" ? JSON.parse(rawCreds) : rawCreds;
    return linkedCreds.isLinkedCreds(creds);
  } catch {
    return false;
  }
}

// Panel mode must not create a fresh pairing attempt on a brand-new install,
// but once a real pairing exists a process restart should restore that session
// automatically. Headless has no Start button, so it always forces a start.
export function sessionStartupPolicy({ autoStart = false, wasPaired = false } = {}) {
  if (autoStart) return { start: true, reason: "autostart" };
  if (wasPaired) return { start: true, reason: "resume-paired" };
  return { start: false, reason: null };
}
