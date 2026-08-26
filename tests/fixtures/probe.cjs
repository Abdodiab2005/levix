// Records which modules a real CLI run actually loaded.
//
// Preloaded with `node --require`, so it measures the genuine `levix ...`
// process rather than a test's imitation of it. Writes one module path per
// line to $PROBE_OUT.
//
// It writes on a timer as well as on exit: a long-running bot is stopped with
// a signal, and how much of an exit handler survives that is exactly the kind
// of timing the test must not depend on. The file is therefore always current
// to within a moment, whether the process exits cleanly or is killed.

const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");

// `--require` preloads run in worker threads too, and pino's file transport is
// a worker. Its module list is a different (much smaller) one, and letting it
// write here overwrote the bot's — which made every "was never loaded" check
// pass for entirely the wrong reason.
if (!isMainThread) return;

function dump() {
  try {
    fs.writeFileSync(process.env.PROBE_OUT, Object.keys(require.cache).join("\n"));
  } catch {}
}

const timer = setInterval(dump, 250);
timer.unref();

process.on("exit", dump);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, dump);
