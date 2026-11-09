// !listschedules and !deleteschedule act only on the chat they run in, and
// list times in the configured timezone.

import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-schedule-scope");

const scheduler = harnessRequire("./scheduler.cjs");
const storage = harnessRequire("./src/utils/storage.cjs");
const settings = harnessRequire("./src/config/settings.cjs");
const { t, intlTag } = harnessRequire("./src/utils/i18n.cjs");
const listschedules = harnessRequire("./src/commands/listschedules.cjs");
const deleteschedule = harnessRequire("./src/commands/deleteschedule.cjs");

const GROUP_A = "120363111@g.us";
const GROUP_B = "120363222@g.us";
const PRIVATE = "201000000000@s.whatsapp.net";
const PRIVATE_LID = "201000000000@lid";
const OWNER = "201000000000@s.whatsapp.net";
const ONCE_DATE = "2030-06-15T12:00:00.000Z";

function recurring(id, targetJid, message) {
  return {
    id,
    type: "recurring",
    targetJid,
    creatorJid: OWNER,
    message,
    cronString: "0 9 * * 1",
    status: "active",
  };
}

scheduler.saveScheduledJob(recurring("scope-a", GROUP_A, "ALPHA-secret"));
scheduler.saveScheduledJob(recurring("scope-b", GROUP_B, "BRAVO-note"));
scheduler.saveScheduledJob(recurring("scope-p", PRIVATE, "PRIVATE-note"));
scheduler.saveScheduledJob(recurring("scope-p-lid", PRIVATE_LID, "LID-note"));
scheduler.saveScheduledJob({
  id: "scope-b-once",
  type: "once",
  targetJid: GROUP_B,
  creatorJid: OWNER,
  message: "BRAVO-once",
  date: ONCE_DATE,
  status: "pending",
});

// A fake socket that records what the command sent.
function fakeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content) {
      sent.push({ jid, content });
    },
  };
}

function msgFrom(chat) {
  return { key: { remoteJid: chat, participant: "201111111111@s.whatsapp.net", fromMe: false } };
}

async function runList(chat) {
  const sock = fakeSock();
  await listschedules.execute(sock, msgFrom(chat), []);
  return sock.sent;
}

async function runDelete(chat, id) {
  const sock = fakeSock();
  await deleteschedule.execute(sock, msgFrom(chat), id ? [id] : []);
  return sock.sent;
}

section("the chat filter matches the exact chat only");

{
  const ids = (chat) =>
    scheduler
      .getScheduledJobsForChat(chat)
      .map((job) => job.id)
      .sort();
  equal("group A has its own job", ids(GROUP_A).join(","), "scope-a");
  equal("group B has its own jobs", ids(GROUP_B).join(","), "scope-b,scope-b-once");
  equal(
    "a group JID is compared after normalization",
    ids("120363222:3@g.us").join(","),
    "scope-b,scope-b-once",
  );
  equal("a private JID matches exactly", ids(PRIVATE).join(","), "scope-p");
  equal(
    "the same digits on another server do not match",
    ids(PRIVATE_LID).join(","),
    "scope-p-lid",
  );
  equal(
    "a private JID with a device suffix is not the same chat",
    ids("201000000000:5@s.whatsapp.net").length,
    0,
  );
  equal("a bare number is not a chat", ids("201000000000").length, 0);
  equal("no chat lists nothing", ids(undefined).length, 0);
}

section("!listschedules from group B shows only B's jobs");

{
  const sent = await runList(GROUP_B);
  equal("one reply", sent.length, 1);
  equal("the reply stays in group B", sent[0].jid, GROUP_B);
  const text = sent[0].content.text;
  ok("B's recurring job is listed", text.includes("BRAVO-note") && text.includes("scope-b"));
  ok("B's one-off job is listed", text.includes("BRAVO-once") && text.includes("scope-b-once"));
  ok("A's text is absent", !text.includes("ALPHA-secret"));
  ok("A's id is absent", !text.includes("scope-a"));
  ok(
    "the private chat's text is absent",
    !text.includes("PRIVATE-note") && !text.includes("LID-note"),
  );
  ok("the private chat's id is absent", !text.includes("scope-p"));
}

section("!listschedules answers 'none' when this chat has no jobs");

{
  const sent = await runList("120363333@g.us");
  equal("one reply", sent.length, 1);
  equal("the none text", sent[0].content.text, t("bot.schedules.listschedules.none"));
}

section("!listschedules prints times in the configured timezone");

{
  const expected = (zone) => new Date(ONCE_DATE).toLocaleString(intlTag(), { timeZone: zone });
  equal(
    "the two zones print differently",
    expected("Asia/Tokyo") === expected("America/New_York"),
    false,
  );

  settings.set("bot_timezone", "Asia/Tokyo");
  const tokyo = (await runList(GROUP_B))[0].content.text;
  ok("Tokyo time is printed", tokyo.includes(expected("Asia/Tokyo")));
  ok("Cairo is no longer hard-coded", !tokyo.includes(expected("Africa/Cairo")));

  settings.set("bot_timezone", "America/New_York");
  const newYork = (await runList(GROUP_B))[0].content.text;
  ok("the setting is read at call time", newYork.includes(expected("America/New_York")));
  ok("the old zone is gone", !newYork.includes(expected("Asia/Tokyo")));

  settings.set("bot_timezone", "Africa/Cairo");
}

section("!deleteschedule treats another chat's id as unknown");

{
  const unknown = await runDelete(GROUP_B, "no-such-id");
  equal(
    "an unknown id answers notFound",
    unknown[0].content.text,
    t("bot.schedules.deleteschedule.notFound", { id: "no-such-id" }),
  );

  const foreign = await runDelete(GROUP_B, "scope-a");
  equal("one reply", foreign.length, 1);
  equal(
    "A's id from B answers exactly like an unknown id",
    foreign[0].content.text,
    t("bot.schedules.deleteschedule.notFound", { id: "scope-a" }),
  );
  ok("A's job survives", Boolean(storage.getSchedule("scope-a")));

  const privateId = await runDelete(GROUP_B, "scope-p");
  equal(
    "the private chat's id from B answers notFound",
    privateId[0].content.text,
    t("bot.schedules.deleteschedule.notFound", { id: "scope-p" }),
  );
  ok("the private chat's job survives", Boolean(storage.getSchedule("scope-p")));
  ok("the other private job survives", Boolean(storage.getSchedule("scope-p-lid")));

  const own = await runDelete(GROUP_B, "scope-b");
  equal(
    "B's own id is deleted",
    own[0].content.text,
    t("bot.schedules.deleteschedule.deleted", { id: "scope-b" }),
  );
  ok("B's job is gone", !storage.getSchedule("scope-b"));
  ok("B's other job is untouched", Boolean(storage.getSchedule("scope-b-once")));
  ok("A's job still survives", Boolean(storage.getSchedule("scope-a")));

  const missing = await runDelete(GROUP_B);
  equal(
    "a missing id still asks for one",
    missing[0].content.text,
    t("bot.schedules.deleteschedule.missingId"),
  );
}

finish();
