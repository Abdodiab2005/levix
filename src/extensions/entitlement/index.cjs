// Levix Plus entitlement: the interface the extension host reads.
//
// Phase 08 slice 08-0 interface stub. Slice 08b replaces the body with the
// verifier, the cache and the refresh client (docs/plans/v5/PHASE-08-PLAN.md
// section 4). Until then nothing is entitled, so Core stays Free.

/** @typedef {"none"|"active"|"grace"|"canceled"|"inactive"|"expired"|"clock"|"unverified"} EntitlementState */

const NONE = Object.freeze({ state: "none", until: null, reason: null });

/** True only while a verified, unexpired entitlement grants `name`. Read at call time. */
function isActive(_name = "plus") {
  return false;
}

/** @returns {Readonly<{state: EntitlementState, until: string|null, reason: string|null}>} */
function status() {
  return NONE;
}

/** Calls `listener(status())` after every change. Returns an unsubscribe function. */
function subscribe(_listener) {
  return () => {};
}

/** Starts the refresh schedule. Returns a stop function. No-op without a stored entitlement. */
function start() {
  return () => {};
}

module.exports = { isActive, status, subscribe, start };
