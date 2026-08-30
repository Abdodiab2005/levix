// Decide whether the WhatsApp session should be started during process boot.
//
// Panel mode must not create a fresh pairing attempt on a brand-new install,
// but once credentials exist a process restart should restore that session
// automatically. Headless has no Start button, so it always forces a start.
export function sessionStartupPolicy({ autoStart = false, wasPaired = false } = {}) {
  if (autoStart) return { start: true, reason: "autostart" };
  if (wasPaired) return { start: true, reason: "resume-paired" };
  return { start: false, reason: null };
}
