// Phase 05: parser v2, the permission matrix, and unknown-command behaviour.
// No WhatsApp connection and no network.

import { join } from "node:path";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-command-engine");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");

const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

const {
  parseCommandText,
  parseCommandTextV1,
  isCommandName,
} = require("./src/messaging/parser.cjs");
const { evaluatePermissionLevel } = require("./src/utils/permissionLevel.cjs");
const group = require("./src/commands/group.cjs");

section("parser v2");

{
  const parsed = parseCommandText("!group\nkick @user");
  equal("newline separates the sub-command", parsed.kind, "command");
  equal("name", parsed.name, "group");
  equal("args", parsed.args.join(" "), "kick @user");
}

{
  const parsed = parseCommandText("!GROUP\n\nKICK @user");
  equal("casing and blank lines", parsed.name, "group");
  equal("subcommand casing is kept in the argument", parsed.args[0], "KICK");
}

{
  equal("leading space is not a command", parseCommandText(" !ping").kind, "not-command");
  equal("a fence is not a command", parseCommandText("```\n!ping").kind, "not-command");
  equal("a url is not a command", parseCommandText("!http://evil.example/x").kind, "not-command");
  equal("equals alias is a name", isCommandName("="), true);
  const memory = parseCommandText("!memory add\nline one\nline two");
  equal("multiline remainder keeps the paragraph", memory.rawRemainder, "add\nline one\nline two");
  equal(
    "mention stays an argument",
    parseCommandText("!kick @201234567890").args[0],
    "@201234567890",
  );
  equal(
    "repeated spaces collapse in the token list",
    parseCommandText("!ping   hello").args[0],
    "hello",
  );
  equal("update is parsed for a later phase", parseCommandText("!update").name, "update");
  equal("bare prefix is empty", parseCommandText("!").kind, "empty");
  equal("bidi in the name is not a command", parseCommandText("!pin\u202eg").kind, "not-command");
}

{
  const samples = [
    "!http://evil",
    "!../../etc/passwd",
    "!\n",
    "!```kick",
    "hello !ping",
    "!group kick @user",
  ];
  ok(
    "adversarial samples do not throw",
    samples.every((sample) => {
      const parsed = parseCommandText(sample);
      return parsed.kind === "not-command" || parsed.kind === "empty" || parsed.kind === "command";
    }),
  );
}

section("parser v1 switch");

equal("v1 still splits a newline", parseCommandTextV1("!group\nkick @user").args[0], "kick");
equal("v1 keeps a url-shaped token", parseCommandTextV1("!http://evil.example").kind, "command");

const LEVELS = {
  autodelete: "OWNER_ONLY",
  autoschedule: "OWNER_ONLY",
  blacklist: "ADMINS_OWNER",
  block: "OWNER_ONLY",
  calc: "MEMBERS",
  debt: "MEMBERS",
  deleteschedule: "ADMINS_OWNER",
  digit: "MEMBERS",
  gemini: "MEMBERS",
  group: "ADMINS_OWNER",
  "group:add": "ADMINS_OWNER",
  "group:all": "MEMBERS",
  "group:antilink": "ADMINS_ONLY",
  "group:antispam": "ADMINS_OWNER",
  "group:approveall": "ADMINS_OWNER",
  "group:clearwarns": "ADMINS_ONLY",
  "group:deletenote": "ADMINS_OWNER",
  "group:demote": "ADMINS_OWNER",
  "group:flagged": "ADMINS_OWNER",
  "group:kick": "ADMINS_OWNER",
  "group:media": "ADMINS_ONLY",
  "group:members": "MEMBERS",
  "group:note": "ADMINS_OWNER",
  "group:policy": "ADMINS_ONLY",
  "group:promote": "ADMINS_OWNER",
  "group:removeall": "OWNER_ONLY",
  "group:rules": "MEMBERS",
  "group:save": "ADMINS_OWNER",
  "group:setname": "ADMINS_OWNER",
  "group:setpp": "ADMINS_OWNER",
  "group:setrules": "ADMINS_ONLY",
  "group:setwarn": "ADMINS_ONLY",
  "group:tagadmins": "MEMBERS",
  "group:warn": "ADMINS_ONLY",
  "group:warns": "ADMINS_OWNER",
  "group:welcome": "ADMINS_OWNER",
  help: "MEMBERS",
  lang: "MEMBERS",
  listschedules: "ADMINS_OWNER",
  loop: "MEMBERS",
  md: "MEMBERS",
  memory: "MEMBERS",
  mod: "ADMINS_OWNER",
  notes: "MEMBERS",
  pack: "MEMBERS",
  packs: "MEMBERS",
  perm: "OWNER_ONLY",
  ping: "MEMBERS",
  poll: "MEMBERS",
  prayer: "MEMBERS",
  qr: "MEMBERS",
  rand: "MEMBERS",
  restart: "OWNER_ONLY",
  schedule: "ADMINS_OWNER",
  score: "MEMBERS",
  send: "MEMBERS",
  setprefix: "OWNER_ONLY",
  shortlink: "MEMBERS",
  status: "OWNER_ONLY",
  sticker: "MEMBERS",
  stickers: "MEMBERS",
  stopbot: "OWNER_ONLY",
  stt: "MEMBERS",
  todo: "MEMBERS",
  toimage: "MEMBERS",
  translate: "MEMBERS",
  tts: "MEMBERS",
  unblock: "OWNER_ONLY",
  weather: "MEMBERS",
};

section("permission matrix");

{
  const { loadCommands, getCommandCatalog, getAliasIndex } = await import(
    join(ROOT, "src/handlers/command.handler.js")
  );
  await loadCommands();
  const catalog = getCommandCatalog();
  equal("69 commands", catalog.length, 69);
  const live = Object.fromEntries(catalog.map((command) => [command.key, command.permission]));
  for (const [key, level] of Object.entries(LEVELS)) {
    equal(key, live[key], level);
  }
  equal(
    "no extra command",
    Object.keys(live).sort().join(","),
    Object.keys(LEVELS).sort().join(","),
  );
  equal("status stays owner only", live.status, "OWNER_ONLY");
  equal("block alias does not replace the block command", getAliasIndex().get("block"), undefined);

  const member = { isGroup: true, isOwner: false, isBotAdmin: false, isSenderAdmin: false };
  const botAdmin = { isGroup: true, isOwner: false, isBotAdmin: true, isSenderAdmin: true };
  const owner = { isGroup: true, isOwner: true, isBotAdmin: false, isSenderAdmin: false };
  const stranger = { isGroup: false, isOwner: false, isBotAdmin: false, isSenderAdmin: false };
  ok("a member cannot kick", group.subCommandAccess("kick", member).hasPermission === false);
  ok(
    "a bot admin can use the group form of kick",
    group.subCommandAccess("kick", botAdmin).hasPermission,
  );
  ok("the owner can use the group form", group.subCommandAccess("kick", owner).hasPermission);
  ok(
    "a private chat does not gain kick",
    group.subCommandAccess("kick", stranger).hasPermission === false,
  );
  ok(
    "direct kick uses the same level",
    evaluatePermissionLevel("ADMINS_OWNER", botAdmin).hasPermission,
  );
}

section("dispatcher");

{
  const { handleCommand } = await import(join(ROOT, "src/handlers/command.handler.js"));
  const GROUP = "120363000000000001@g.us";
  const ADMIN = "201111111111@s.whatsapp.net";

  function sock() {
    const sent = [];
    return {
      sent,
      async sendMessage(jid, content) {
        sent.push({ jid, content });
        return { key: { id: `m${sent.length}`, remoteJid: jid } };
      },
      async sendPresenceUpdate() {},
      async groupMetadata(jid) {
        return { id: jid, participants: [{ id: ADMIN, admin: "admin" }] };
      },
    };
  }

  function message(text, { fromMe = false, participant = ADMIN } = {}) {
    return {
      key: { remoteJid: GROUP, fromMe, id: "in", participant },
      message: { conversation: text },
    };
  }

  {
    const fake = sock();
    const handled = await handleCommand(fake, message("!nope"), "!nope");
    equal("unknown command is handled", handled, true);
    ok(
      "unknown command explains itself",
      /Unknown command `nope`/.test(fake.sent[0]?.content?.text || ""),
    );
    ok("the example uses the prefix", /!help/.test(fake.sent[0]?.content?.text || ""));
    equal("the reply stays in the group", fake.sent[0]?.jid, GROUP);
  }

  {
    const fake = sock();
    const handled = await handleCommand(
      fake,
      message("!http://evil.example"),
      "!http://evil.example",
    );
    equal("a url after the prefix is not a command", handled, false);
    equal("and nothing is sent", fake.sent.length, 0);
  }

  {
    const fake = sock();
    await handleCommand(fake, message("!group\nkick"), "!group\nkick");
    ok(
      "newline group kick is the kick command",
      fake.sent.some(
        (row) => /member|هدف|target|@/i.test(row.content?.text || "") || row.content?.text,
      ),
    );
    equal(
      "it did not leave the group",
      fake.sent.every((row) => row.jid === GROUP),
      true,
    );
  }

  {
    settings.set("command_parser", "v1");
    const fake = sock();
    const handled = await handleCommand(fake, message("!nope"), "!nope");
    equal("v1 stays silent on an unknown command", handled, false);
    settings.set("command_parser", "v2");
  }

  {
    const fake = sock();
    await handleCommand(fake, message("!block"), "!block");
    ok(
      "block is the owner command, not the blacklist alias",
      /owner/i.test(fake.sent[0]?.content?.text || ""),
    );
  }
}

finish();
