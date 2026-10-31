// !prayer: today's date in the bot timezone, encoded query, swappable HTTP.
//
// The network is never touched: the command exposes its HTTP GET as `http`,
// and every scenario swaps in a stub.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-prayer");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");

const prayer = require("./src/commands/prayer.cjs");
const { buildPrayerUrl, http } = prayer;

const CHAT = "201111111111@s.whatsapp.net";
const NOW = new Date("2026-01-15T22:30:00Z");
const FROZEN = "06-06-2025";

const TIMINGS = {
  Fajr: "04:15",
  Sunrise: "05:45",
  Dhuhr: "12:00",
  Asr: "15:30",
  Maghrib: "18:05",
  Isha: "19:30",
};

const TIMES_FOR_CAIRO = [
  "*Prayer times for Cairo:*",
  "",
  "Fajr: 4:15 AM",
  "Sunrise: 5:45 AM",
  "Dhuhr: 12:00 PM",
  "Asr: 3:30 PM",
  "Maghrib: 6:05 PM",
  "Isha: 7:30 PM",
].join("\n");

function buildMsg(args) {
  const text = ["!prayer", ...args].join(" ").trim();
  return {
    key: { remoteJid: CHAT, fromMe: true, id: "in" },
    message: { conversation: text },
  };
}

function makeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
  };
}

async function run({ args = [], handler } = {}) {
  if (handler) http.get = handler;
  const sock = makeSock();
  await prayer.execute(sock, buildMsg(args), args);
  return sock.sent;
}

const lastText = (sent) => sent[sent.length - 1]?.content?.text || "";

// DD-MM-YYYY via toLocaleDateString. A different path from the command's formatToParts.
function oracleDate(date, timeZone) {
  return date.toLocaleDateString("en-GB", { timeZone }).replaceAll("/", "-");
}

section("buildPrayerUrl");

{
  const url = buildPrayerUrl("Cairo", { now: NOW, timeZone: "Africa/Cairo" });
  const params = new URL(url).searchParams;
  ok("cairo url has no frozen date", !url.includes(FROZEN));
  equal("cairo local date", new URL(url).pathname, "/v1/timingsByCity/16-01-2026");
  equal("cairo timezone", params.get("timezonestring"), "Africa/Cairo");
  equal("country stays EG", params.get("country"), "EG");
  equal("state stays Egypt", params.get("state"), "Egypt");
  equal("method stays 5", params.get("method"), "5");
  equal("shafaq stays general", params.get("shafaq"), "general");
  equal("tune stays 5", params.get("tune"), "5");
  equal("calendarMethod stays UAQ", params.get("calendarMethod"), "UAQ");
}

{
  const url = buildPrayerUrl("Cairo", { now: NOW, timeZone: "UTC" });
  ok("utc url has no frozen date", !url.includes(FROZEN));
  equal("utc date", new URL(url).pathname, "/v1/timingsByCity/15-01-2026");
  equal("utc timezone", new URL(url).searchParams.get("timezonestring"), "UTC");
}

{
  // The module is already loaded, so this only passes if the setting is read
  // when buildPrayerUrl runs, and again on the next call.
  settings.set("bot_timezone", "Asia/Riyadh");
  const url = buildPrayerUrl("Cairo", { now: NOW });
  ok("riyadh url has no frozen date", !url.includes(FROZEN));
  equal(
    "default timezone is bot_timezone",
    new URL(url).searchParams.get("timezonestring"),
    "Asia/Riyadh",
  );
  equal("riyadh local date", new URL(url).pathname, "/v1/timingsByCity/16-01-2026");

  settings.set("bot_timezone", "UTC");
  const again = buildPrayerUrl("Cairo", { now: NOW });
  equal(
    "timezone is read again at the next call",
    new URL(again).searchParams.get("timezonestring"),
    "UTC",
  );
  equal("the date follows the new timezone", new URL(again).pathname, "/v1/timingsByCity/15-01-2026");
}

{
  const city = "New York&method=1";
  const url = buildPrayerUrl(city, { now: NOW, timeZone: "Africa/Cairo" });
  const params = new URL(url).searchParams;
  ok("injected city url has no frozen date", !url.includes(FROZEN));
  equal("city round-trips", params.get("city"), city);
  equal("injection does not change method", params.get("method"), "5");
  equal("method is present once", params.getAll("method").length, 1);
}

section("execute");

{
  settings.set("bot_timezone", "Africa/Cairo");
  const calls = [];
  const before = oracleDate(new Date(), "Africa/Cairo");
  const sent = await run({
    args: ["Cairo"],
    handler: async (url) => {
      calls.push(url);
      return { data: { data: { timings: TIMINGS } } };
    },
  });
  const after = oracleDate(new Date(), "Africa/Cairo");
  const requested = new URL(calls[0]);
  equal("success: one url", calls.length, 1);
  ok("success: url has no frozen date", !String(calls[0]).includes(FROZEN));
  ok(
    "success: path is today's Cairo date",
    requested.pathname.endsWith(`/${before}`) || requested.pathname.endsWith(`/${after}`),
  );
  equal("success: timezone is Africa/Cairo", requested.searchParams.get("timezonestring"), "Africa/Cairo");
  equal("success: city query", requested.searchParams.get("city"), "Cairo");
  equal("success: method stays 5", requested.searchParams.get("method"), "5");
  equal("fetching notice", sent[0]?.content?.text, "Fetching the times...");
  equal("fetching goes to the source chat", sent[0]?.jid, CHAT);
  equal("the six times", lastText(sent), TIMES_FOR_CAIRO);
  equal("times go to the source chat", sent[sent.length - 1]?.jid, CHAT);
  equal("two messages on success", sent.length, 2);
}

{
  const calls = [];
  const sent = await run({
    args: ["Cairo"],
    handler: async (url) => {
      calls.push(url);
      throw new Error("nope");
    },
  });
  equal("failure: one url", calls.length, 1);
  equal(
    "not-found message",
    lastText(sent),
    `Sorry, I couldn't find prayer times for "Cairo". Check the city's name and try again.`,
  );
  equal("not-found goes to the source chat", sent[sent.length - 1]?.jid, CHAT);
}

{
  const calls = [];
  const sent = await run({
    handler: async (url) => {
      calls.push(url);
      throw new Error("should not be called");
    },
  });
  equal("no args: no request", calls.length, 0);
  equal(
    "usage message",
    lastText(sent),
    "Give the city's name in English.\n\n*Example:* `!prayer cairo`",
  );
  equal("usage goes to the source chat", sent[0]?.jid, CHAT);
  equal("usage is the only message", sent.length, 1);
}

finish();
