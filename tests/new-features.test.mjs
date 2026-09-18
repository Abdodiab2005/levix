import { section, equal, ok, useTempDataDir, finish } from "./harness.mjs";
import { createRequire } from "node:module";

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

section("!lang numeral conversion");

const langCmd = require("../src/commands/lang.cjs");
equal("lang command name is lang", langCmd.name, "lang");
ok("lang aliases include num", langCmd.aliases.includes("num"));

let sentText = "";
const mockSock = {
  async sendMessage(jid, content) {
    sentText = content.text;
    return { key: { id: "mock" } };
  },
};

// Convert English to Arabic numerals inline
await langCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, [
  "ar",
  "Phone:",
  "01012345678",
]);
equal("converts English digits to Arabic digits", sentText, "Phone: ٠١٠١٢٣٤٥٦٧٨");

// Convert Arabic to English numerals inline
await langCmd.execute(mockSock, { key: { remoteJid: "123@s.whatsapp.net" } }, [
  "en",
  "الرقم:",
  "٠١٠١٢٣٤٥٦٧٨",
]);
equal("converts Arabic digits to English digits", sentText, "الرقم: 01012345678");

// Convert via reply
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
await langCmd.execute(mockSock, mockReplyMsg, ["ar"]);
equal("converts digits in replied message to Arabic digits", sentText, "Order #٩٨٧٦٥ ready");

finish();
