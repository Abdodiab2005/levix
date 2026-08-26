// The seam between the bot and whatever is watching it.
//
// The connection handler already reports its state by calling `io.emit(...)`.
// That was fine while socket.io was the only listener, but headless mode has
// no socket.io and still needs to know when a QR arrives or the pairing
// succeeds — and the panel may attach long after the bot has started.
//
// So the bot emits into this hub instead, and listeners attach to it:
//
//   panel     -> forwards every event to socket.io
//   headless  -> prints the ones a person waiting at a terminal cares about
//
// `sink` is shaped like the socket.io server object because that is what
// `setupEventListeners` is handed. Nothing in src/core had to change.

const listeners = new Set();

/** Attach a listener. Returns a function that detaches it. */
function attach(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch {
      // A broken listener must never take the bot down with it.
    }
  }
}

// The `io`-shaped object handed to the WhatsApp event wiring. `use` and `on`
// are no-ops: only the panel's real socket.io server implements those, and it
// wires them itself.
const sink = {
  emit,
  use() {},
  on() {},
};

module.exports = { sink, attach, emit };
