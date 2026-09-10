// Decide whether the WhatsApp session should be started during process boot.
//
// Baileys writes a `creds` row as soon as auth state is initialized, even before
// a QR is successfully paired. `requestPairingCode` also writes `creds.me.id`
// before the phone accepts the code. A finished link has `me.id` and is not
// still `registered: false`.
export function hasPairedCredentials(rawCreds) {
  if (!rawCreds) return false;
  try {
    const creds = typeof rawCreds === "string" ? JSON.parse(rawCreds) : rawCreds;
    if (!creds?.me?.id) return false;
    if (creds.registered === false) return false;
    return true;
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
