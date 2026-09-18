import { createRequire } from "node:module";
import { equal, finish, ok, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("new-features");

const require = createRequire(import.meta.url);
const {
  formatMarkdownForWhatsApp,
  convertMarkdownTables,
  parseMarkdownTable,
} = require("../src/utils/markdownParser.cjs");

section("Markdown to WhatsApp formatting");

const input = "This is **bold**, this is __italic__, this is ~~strikethrough~~, and # Title";
const output = formatMarkdownForWhatsApp(input);
equal(
  "formats bold, italic, strike and headings",
  output,
  "This is *bold*, this is _italic_, this is ~strikethrough~, and *Title*",
);

const codeInput = "Here is `**not bold**` and ```\n**not bold either**\n``` but **this is**";
const codeOutput = formatMarkdownForWhatsApp(codeInput);
ok("preserves inline code", codeOutput.includes("`**not bold**`"));
ok("preserves code blocks", codeOutput.includes("```\n**not bold either**\n```"));
ok("converts bold outside code", codeOutput.includes("*this is*"));

const table = `
| Name | Role | City |
| --- | --- | --- |
| Alice | Admin | Cairo |
| Bob | Member | Alexandria |
`.trim();

const tableOutput = formatMarkdownForWhatsApp(table);
ok("removes markdown table separator", !tableOutput.includes("| --- |"));
ok("formats Alice card", tableOutput.includes("📋 *Alice*"));
ok("formats Alice role", tableOutput.includes("• *Role:* Admin"));
ok("formats Alice city", tableOutput.includes("• *City:* Cairo"));
ok("formats Bob card", tableOutput.includes("📋 *Bob*"));
ok("formats Bob role", tableOutput.includes("• *Role:* Member"));
ok("formats Bob city", tableOutput.includes("• *City:* Alexandria"));

section("!digit numeral conversion");

const digitCmd = require("../src/commands/digit.cjs");
const langCmd = require("../src/commands/lang.cjs");
equal("digit command name is digit", digitCmd.name, "digit");
ok("digit aliases include num", digitCmd.aliases.includes("num"));
ok("digit aliases include digits", digitCmd.aliases.includes("digits"));
equal("lang command name is lang", langCmd.name, "lang");
ok("lang is not also the number converter", !langCmd.aliases.includes("num"));

let sentText = "";
const mockSock = {
  async sendMessage(_jid, content) {
    sentText = content.text;
    return { key: { id: "mock" } };
  },
};

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, [
  "ar",
  "Phone:",
  "01012345678",
]);
equal("converts English digits to Arabic digits", sentText, "Phone: ٠١٠١٢٣٤٥٦٧٨");

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, [
  "en",
  "الرقم:",
  "٠١٠١٢٣٤٥٦٧٨",
]);
equal("converts Arabic digits to English digits", sentText, "الرقم: 01012345678");

const mockReplyMsg = {
  key: { remoteJid: "123@s.whatsapp.net" },
  message: {
    extendedTextMessage: {
      contextInfo: {
        quotedMessage: {
          conversation: "Order #98765 ready",
        },
      },
    },
  },
};
await digitCmd.execute(mockSock, mockReplyMsg, ["ar"]);
equal("converts digits in replied message to Arabic digits", sentText, "Order #٩٨٧٦٥ ready");

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, ["Phone:", "01099"]);
equal("auto-detects English digits and converts to Arabic", sentText, "Phone: ٠١٠٩٩");

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, ["الرقم:", "٠١٠٩٩"]);
equal("auto-detects Arabic digits and converts to English", sentText, "الرقم: 01099");

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, ["mix", "12٣"]);
ok(
  "mixed digits require an explicit language",
  sentText.includes("مختلطة") || sentText.includes("mixed"),
);

await digitCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, ["ar", "12٣"]);
equal("explicit ar converts mixed digits to Arabic", sentText, "١٢٣");

const mixedReply = {
  key: { remoteJid: "123@s.whatsapp.net" },
  message: {
    extendedTextMessage: {
      contextInfo: {
        quotedMessage: { conversation: "Order #98765 ready" },
      },
    },
  },
};
await digitCmd.execute(mockSock, mixedReply, []);
equal("reply with !digit auto-converts English digits to Arabic", sentText, "Order #٩٨٧٦٥ ready");

await langCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, ["ar", "123"]);
ok("!lang with numbers points at !digit", sentText.includes("digit"));

finish();
