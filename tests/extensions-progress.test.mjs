import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-progress");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};
const { createStatus, StatusMessage } = require("./src/utils/statusMessage.cjs");
const { currentCommand } = require("./src/utils/commandContext.cjs");
const { host } = require("./src/extensions/host.cjs");
const originalHide = host.hideProgress;
const CHAT = "201111111111@s.whatsapp.net";
function socket() {
  return {
    user: { id: CHAT },
    sent: [],
    async sendPresenceUpdate() {},
    async sendMessage(jid, content) {
      this.sent.push(content);
      return { key: { remoteJid: jid, id: `status-${this.sent.length}` } };
    },
  };
}

try {
  section("Free reply_hide_progress preserves the pre-extension send sequence");
  {
    settings.set("reply_hide_progress", true);
    host.hideProgress = originalHide;
    const sock = socket();
    const status = await createStatus(sock, CHAT, "starting");
    equal("Free: initial progress hidden", sock.sent.length, 0);
    equal("Free: first update sent fresh", await status.update("working"), true);
    status.lastEditAt = 0;
    await status.update("more work", { force: true });
    status.lastEditAt = 0;
    await status.update("security notice", { category: "security" });
    status.lastEditAt = 0;
    await status.update("progress again", { category: "progress" });
    status.lastEditAt = 0;
    await status.finish("done");
    const edit = { remoteJid: CHAT, id: "status-1" };
    // Golden payloads from 2439bc4~1: one fresh update, then edits of that message.
    equal(
      "Free: byte-identical send sequence",
      JSON.stringify(sock.sent),
      JSON.stringify([
        { text: "working", linkPreview: null },
        { text: "more work", edit },
        { text: "security notice", edit },
        { text: "progress again", edit },
        { text: "done", edit },
      ]),
    );
    const failure = await createStatus(sock, CHAT, "another start");
    await failure.fail(new Error("failed"), "Failure");
    ok("Free: failure delivered", sock.sent.at(-1)?.text.includes("failed"));
  }

  for (const freeHide of [false, true]) {
    section(`Plus-hidden progress stays suppressed with Free setting ${freeHide ? "on" : "off"}`);
    settings.set("reply_hide_progress", freeHide);
    host.hideProgress = () => true;
    const sock = socket();
    const status = await createStatus(sock, CHAT, "starting");
    equal("Plus: initial progress hidden", sock.sent.length, 0);
    equal("Plus: update hidden", await status.update("working"), false);
    equal(
      "Plus: forced progress update hidden",
      await status.update("more work", { force: true }),
      false,
    );
    settings.set("reply_hide_progress", false);
    host.hideProgress = () => false;
    await status.update("still working");
    equal("Plus: suppression lasts for this status", sock.sent.length, 0);
    await status.update("security notice", { category: "security" });
    equal("Plus: security notice delivered", sock.sent[0]?.text, "security notice");
    await status.update("progress again", { category: "progress" });
    equal("Plus: progress remains hidden even with a message key", sock.sent.length, 1);
    status.lastEditAt = 0;
    await status.finish("done");
    equal("Plus: result delivered", sock.sent.at(-1)?.text, "done");

    settings.set("reply_hide_progress", freeHide);
    host.hideProgress = () => true;
    const failure = await createStatus(sock, CHAT, "another start");
    await failure.fail(new Error("failed"), "Failure");
    ok("Plus: failure delivered", sock.sent.at(-1)?.text.includes("failed"));
  }

  section("ordinary Free progress bytes remain unchanged");
  settings.set("reply_hide_progress", false);
  host.hideProgress = originalHide;
  const sock = socket();
  const status = await createStatus(sock, CHAT, "starting");
  status.lastEditAt = 0;
  await status.update("working");
  status.lastEditAt = 0;
  await status.finish("done");
  equal(
    "same three texts",
    sock.sent.map((entry) => entry.text).join("|"),
    "starting|working|done",
  );

  section("dispatcher supplies canonical command through concurrent async execution");
  const config = require("./src/config/runtime-config.cjs");
  const { handleCommand, getLoadedCommands, rebuildCommandIndex } = await import(
    "../src/handlers/command.handler.js"
  );
  const commands = getLoadedCommands();
  const seen = [];
  const handles = [];
  host.hideProgress = ({ command }) => {
    seen.push(command);
    return command === "ping";
  };
  for (const name of ["ping", "help"]) {
    commands.set(name, {
      name,
      chat: "all",
      async execute(commandSock, msg) {
        await new Promise((resolve) => setImmediate(resolve));
        const handle = await createStatus(commandSock, msg.key.remoteJid, `${name} progress`);
        handles.push(handle);
        equal(`${name}: context survives async work`, currentCommand(), name);
        equal(`${name}: status inherits command`, handle.command, name);
        equal(
          `${name}: explicit option wins`,
          new StatusMessage(commandSock, CHAT, { command: "explicit" }).command,
          "explicit",
        );
      },
    });
  }
  config.setAliases("ping", ["p"]);
  rebuildCommandIndex();
  const commandSock = socket();
  await Promise.all(
    ["p", "help"].map((name) =>
      handleCommand(
        commandSock,
        {
          key: { remoteJid: CHAT, fromMe: true, id: name },
          message: { conversation: `!${name}` },
        },
        `!${name}`,
      ),
    ),
  );
  equal("both commands reached the Plus hook", seen.slice().sort().join(","), "help,ping");
  equal(
    "alias hides the canonical command only",
    handles.find((entry) => entry.command === "ping")?.suppressed,
    true,
  );
  equal(
    "other command progress is shown",
    handles.find((entry) => entry.command === "help")?.suppressed,
    false,
  );
  equal("context does not leak outside execution", currentCommand(), null);
  equal("status outside a command stays null", new StatusMessage(commandSock, CHAT).command, null);
  config.setAliases("ping", null);
} finally {
  host.hideProgress = originalHide;
  settings.set("reply_hide_progress", false);
}

finish();
