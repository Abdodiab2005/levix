// !removeall is disabled (one line, no removal) and !add on a privacy block ends
// on the privacy line, called the way the dispatcher calls it (6 arguments, the
// last one its ctx object) and the way a nested dispatch does (5 arguments).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  ROOT,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-group-removeall-add");

const { t, withLang } = harnessRequire("./src/utils/i18n.cjs");
const removeall = harnessRequire("./src/commands/group/removeall.cjs");
const add = harnessRequire("./src/commands/group/add.cjs");

const GROUP = "120363444@g.us";
const ADMIN = "201111111111@s.whatsapp.net";
const TARGET = "201555555555@s.whatsapp.net";

function fakeSock({ addStatus = "403" } = {}) {
  const sent = [];
  const updates = [];
  return {
    sent,
    updates,
    user: { id: "209999999999@s.whatsapp.net" },
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { id: `out-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
    async groupParticipantsUpdate(jid, users, action) {
      updates.push({ jid, users: [...users], action });
      return [{ status: addStatus, jid: users[0] }];
    },
  };
}

const roster = { participants: [{ id: ADMIN, admin: "admin" }] };
const texts = (sent) =>
  sent.filter((entry) => typeof entry.content.text === "string").map((e) => e.content.text);

function commandMessage(extra = {}) {
  return {
    key: { remoteJid: GROUP, participant: ADMIN, fromMe: false },
    message: { extendedTextMessage: { contextInfo: { mentionedJid: [TARGET] } } },
    pushName: "Admin",
    ...extra,
  };
}

section("!removeall sends one line and removes nobody");

{
  const unavailable = t("bot.group.removeall.unavailable");
  equal(
    "the English line",
    withLang("en", () => t("bot.group.removeall.unavailable")),
    "Removing every member at once is not available. Remove members one at a time with kick.",
  );

  const viaDispatcher = fakeSock();
  await removeall.execute(viaDispatcher, commandMessage(), [], "", roster, {
    invokedName: "removeall",
  });
  equal("dispatcher call: exactly one message", viaDispatcher.sent.length, 1);
  equal("dispatcher call: the unavailable text", viaDispatcher.sent[0].content.text, unavailable);
  equal("dispatcher call: sent to the group", viaDispatcher.sent[0].jid, GROUP);
  equal("dispatcher call: no participant update", viaDispatcher.updates.length, 0);

  const nested = fakeSock();
  await removeall.execute(nested, commandMessage(), [], "", roster);
  equal("nested call: exactly one message", nested.sent.length, 1);
  equal("nested call: the unavailable text", nested.sent[0].content.text, unavailable);
  equal("nested call: no participant update", nested.updates.length, 0);
}

section("!add on a privacy block keeps the privacy line");

{
  const privacy = t("bot.group.add.privacyBlocked", { number: TARGET.split("@")[0] });
  const failed = t("bot.group.add.failed");

  for (const [label, extraArgs] of [
    ["dispatcher call (6 arguments)", [{ invokedName: "add", rawRemainder: "" }]],
    ["nested call (5 arguments)", []],
  ]) {
    const sock = fakeSock({ addStatus: "403" });
    let thrown = null;
    try {
      await add.execute(sock, commandMessage(), ["@member"], "", roster, ...extraArgs);
    } catch (error) {
      thrown = error;
    }
    equal(`${label}: does not throw`, thrown, null);
    equal(`${label}: one add attempt`, sock.updates.length, 1);
    equal(`${label}: the attempt is an add`, sock.updates[0]?.action, "add");
    const lines = texts(sock.sent);
    equal(`${label}: the last line is the privacy line`, lines.at(-1), privacy);
    ok(`${label}: no failure card`, !lines.includes(failed));
  }
}

section("the new text exists in every locale");

{
  const read = (locale, file) => JSON.parse(readFileSync(join(ROOT, "i18n", locale, file), "utf8"));
  const descriptions = new Set();
  for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
    const group = read(locale, "bot/group.json");
    ok(`${locale}: removeall.unavailable is present`, Boolean(group["removeall.unavailable"]));
    ok(`${locale}: removeall.confirm is kept`, Boolean(group["removeall.confirm"]));
    const description = read(locale, "commands.json")["group.removeall.description"];
    ok(`${locale}: the description is present`, Boolean(description));
    descriptions.add(description);
  }
  equal("every locale has its own description", descriptions.size, 4);
  equal(
    "the English description says it is unavailable",
    read("en", "commands.json")["group.removeall.description"],
    "Not available: removing every member at once is disabled.",
  );
}

finish();
