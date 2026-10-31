// sendBotMessage: typing presence, delays, and quoting.
//
// The typing delay (400 to 2500 ms) and the inter-message gap are real waits,
// so this file replaces timing.sleep with a recorder that keeps the requested
// milliseconds and resolves at once. It checks the delays the helper asks for,
// and that presence, sleep and the message happen in that order.

import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-send-bot-message");

const settings = require("./src/config/settings.cjs");
const { sendBotMessage, timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));

// Each element is one requested delay, in ms, in the order asked for.
const sleeps = [];
timing.sleep = async (ms) => {
  sleeps.push(ms);
};

// No inter-message gap unless a section sets one.
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

/** A socket that records presence and send calls in one ordered event list. */
function captureSock() {
  const events = [];
  return {
    events,
    async sendPresenceUpdate(presence, jid) {
      events.push({ presence, jid });
    },
    async sendMessage(jid, content, opts) {
      events.push({ jid, content, opts });
      return { key: { id: `out-${events.length}` } };
    },
  };
}

section("typing is composing, delay, paused, message");

{
  const sock = captureSock();
  sleeps.length = 0;
  await sendBotMessage(sock, "201000000001@s.whatsapp.net", { text: "x".repeat(40) });

  equal("composing first", sock.events[0]?.presence, "composing");
  equal("then paused", sock.events[1]?.presence, "paused");
  ok("then the message itself", sock.events[2]?.content?.text === "x".repeat(40));
  equal("nothing after the message", sock.events.length, 3);

  // 40 characters is 1000 ms before the jitter: typingDelayFor uses
  // (text.length / 40) * 1000, clamped to [400, 2500], then 0.85 to 1.15.
  equal("one sleep was requested", sleeps.length, 1);
  ok(
    "the 40-character typing delay is 1000 ms plus or minus 15%",
    sleeps[0] >= 850 && sleeps[0] <= 1149,
  );
}

{
  // A short text sits on the 400 ms clamp floor.
  const sock = captureSock();
  sleeps.length = 0;
  await sendBotMessage(sock, "201000000002@s.whatsapp.net", { text: "hi" });
  ok(
    "a short text sleeps at the 400 ms floor, jittered (340 to 459)",
    sleeps[0] >= 340 && sleeps[0] <= 459,
  );
}

{
  // A long text sits on the 2500 ms clamp ceiling.
  const sock = captureSock();
  sleeps.length = 0;
  await sendBotMessage(sock, "201000000003@s.whatsapp.net", { text: "y".repeat(400) });
  ok(
    "a 400-character text sleeps at the 2500 ms ceiling, jittered (2125 to 2874)",
    sleeps[0] >= 2125 && sleeps[0] <= 2874,
  );
}

section("typing can be turned off");

{
  const sock = captureSock();
  sleeps.length = 0;
  await sendBotMessage(
    sock,
    "201000000004@s.whatsapp.net",
    { text: "no typing here" },
    { typing: false },
  );
  equal("only the message is recorded", sock.events.length, 1);
  equal("no presence", sock.events[0]?.presence, undefined);
  equal("no sleep", sleeps.length, 0);
}

section("the inter-message gap");

{
  const jid = "201000000005@s.whatsapp.net";
  settings.set("bot_min_delay_ms", 300);
  settings.set("bot_max_delay_ms", 300);
  const sock = captureSock();
  sleeps.length = 0;

  // The first send to a chat has no previous timestamp, so it never waits.
  await sendBotMessage(sock, jid, { text: "one" }, { typing: false });
  equal("the first send waits for nothing", sleeps.length, 0);

  // The second send, right after it, waits out the rest of the 300 ms gap.
  await sendBotMessage(sock, jid, { text: "two" }, { typing: false });
  equal("the second send records one gap sleep", sleeps.length, 1);
  ok("the gap is between 1 and 300 ms", sleeps[0] >= 1 && sleeps[0] <= 300);

  settings.set("bot_min_delay_ms", 0);
  settings.set("bot_max_delay_ms", 0);
  sleeps.length = 0;
  await sendBotMessage(sock, jid, { text: "three" }, { typing: false });
  equal("both settings at 0 means no gap sleep", sleeps.length, 0);
}

section("quoting");

{
  const replyTo = { key: { id: "in-1", remoteJid: "201000000006@s.whatsapp.net" } };
  const sock = captureSock();
  await sendBotMessage(
    sock,
    "201000000006@s.whatsapp.net",
    { text: "quoted" },
    { typing: false, replyTo },
  );
  equal("replyTo becomes opts.quoted", sock.events[0]?.opts?.quoted, replyTo);

  const sock2 = captureSock();
  await sendBotMessage(
    sock2,
    "201000000007@s.whatsapp.net",
    { text: "bare" },
    { typing: false, replyTo, quote: false },
  );
  ok("quote false sends no quoted message", !sock2.events[0]?.opts?.quoted);
}

finish();
