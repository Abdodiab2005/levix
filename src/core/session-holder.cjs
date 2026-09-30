// A process-wide pointer to the backend's session manager.
//
// The state machine in session.js is the only thing allowed to create or
// destroy a Baileys socket, but it is built once in bootstrap/core.js and not
// every caller sits on that dependency path — the WhatsApp commands (!stopbot,
// !restart) don't (the panel gets its own hand-over in bootstrap/panel.js).
// bootstrapCore() sets this right after constructing the manager; commands
// read it at call time.
//
// Null until the core is up — callers answer that with a friendly line,
// never a crash.

let session = null;

function setSession(manager) {
  session = manager;
}

function getSession() {
  return session;
}

module.exports = { setSession, getSession };
