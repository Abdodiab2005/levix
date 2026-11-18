// Real bootstrap and session recovery, with start forbidden before any socket.
import "./fixtures/no-external-network.cjs";
import { equal, finish, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-bootstrap-unlink");

const store = require("./src/db/store.cjs");
const lock = require("./src/config/lock.cjs");
const { WhatsAppSession, SESSION_STATES: S } = await import("../src/core/session.js");
const { bootstrapCore } = await import("../src/bootstrap/core.js");
const originalStart = WhatsAppSession.prototype.start;
const originalRead = store.isUnlinkPending;
const originalMark = store.markUnlinkPending;
const originalWipe = store.authClearAll;
let starts = 0;
WhatsAppSession.prototype.start = async () => {
  starts += 1;
  throw new Error("boot must not start a socket while unlink is uncertain");
};

try {
  for (const mode of ["read", "write", "wipe"]) {
    section(`bootstrapCore survives pending-unlink ${mode} failure without resume`);
    store.clearUnlinkPending();
    const creds = JSON.stringify({ me: { id: "2015550105@s.whatsapp.net" }, registered: true });
    store.authWrite("creds", creds);
    if (mode !== "read") store.markUnlinkPending();
    const failure = () => {
      throw Object.assign(new Error(`unlink ${mode} failed`), { code: "SQLITE_FULL" });
    };
    let wipes = 0;
    store.authClearAll = () => {
      wipes += 1;
      if (mode === "wipe") failure();
      return originalWipe();
    };
    if (mode === "read") store.isUnlinkPending = failure;
    if (mode === "write") store.markUnlinkPending = failure;
    let core;
    try {
      core = await bootstrapCore({ autoStart: true });
      equal("boot returns ERROR without crashing", core.session.state, S.ERROR);
      equal("boot reports incomplete unlink", core.session.getState().reason, "unlink_incomplete");
      equal("boot refuses to claim linked credentials", core.session.getState().linked, false);
      equal("boot did not call start", starts, 0);
      equal("boot installed no socket", core.session.socket, null);
      equal("only a readable, recorded intent reaches the wipe", wipes, mode === "wipe" ? 1 : 0);
      equal("failed boot recovery preserves credentials", store.authRead("creds"), creds);
      if (mode !== "read") equal("failed boot recovery keeps intent", originalRead(), true);
    } finally {
      store.isUnlinkPending = originalRead;
      store.markUnlinkPending = originalMark;
      store.authClearAll = originalWipe;
      core?.stopRemoteTerms();
      await core?.session.shutdown();
      lock.release();
    }
  }
} finally {
  WhatsAppSession.prototype.start = originalStart;
  store.isUnlinkPending = originalRead;
  store.markUnlinkPending = originalMark;
  store.authClearAll = originalWipe;
  store.clearUnlinkPending();
  lock.release();
}

finish();
