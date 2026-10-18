import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-markdown");
const {
  formatMarkdownForWhatsApp: format,
  parseMarkdownTable,
} = require("./src/utils/markdownParser.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

section("WhatsApp styles without corrupting literal content");
for (const [input, output] of [
  ["**Bold** __Italic__ ~~Strike~~", "*Bold* _Italic_ ~Strike~"],
  ["***Both*** ___Both___", "*_Both_* *_Both_*"],
  ["**عريض** __مائل__", "*عريض* _مائل_"],
  [
    "*Already bold* _already italic_ ~already struck~",
    "*Already bold* _already italic_ ~already struck~",
  ],
  ["**Bold _and italic_**", "*Bold _and italic_*"],
  ["my__file__name and __italic__", "my__file__name and _italic_"],
  ["# **Title** ###\n\nParagraph", "*Title*\n\nParagraph"],
  ["Title\n=====\n\n---", "*Title*\n\n──────────"],
  ["# Be **kind** now", "*Be kind now*"],
  ["This is not # a heading", "This is not # a heading"],
  ["- One\n  + Nested\n* Two\n2) Next", "• One\n  • Nested\n• Two\n2. Next"],
  ["- [x] Done\n- [ ] Waiting\n> Quote", "☑ Done\n☐ Waiting\n> Quote"],
  ["- - -\n\n* * *", "──────────\n\n──────────"],
  ["", ""],
  [null, null],
  ["\x00WA0\x00 **real**", "\x00WA0\x00 *real*"],
  ["**hello**\r\n\r\n__world__", "*hello*\n\n_world_"],
])
  equal(`formats ${JSON.stringify(input)}`, format(input), output);

section("code, links and URLs retain their payload");
for (const [input, output] of [
  ["`**raw** | __id__` **outside**", "`**raw** | __id__` *outside*"],
  [
    "```js\nconst x = '**raw**';\n  x += 1;\n```\n**outside**",
    "```\nconst x = '**raw**';\n  x += 1;\n```\n*outside*",
  ],
  ["~~~python\n# raw\n**raw**\n~~~", "```\n# raw\n**raw**\n```"],
  ["```js\n**unfinished code**", "```\n**unfinished code**\n```"],
  ["``a `tick` and **raw**``", "```a `tick` and **raw**```"],
  ["https://example.com/a__b__c?q=**raw**", "https://example.com/a__b__c?q=**raw**"],
  [
    "[**Docs**](https://example.com/a_(b)) and [Other](https://example.com/c_d)",
    "*Docs*: https://example.com/a_(b) and Other: https://example.com/c_d",
  ],
  ['[Docs](<https://example.com/a_b> "Title")', "Docs: https://example.com/a_b"],
  ["![A chart](https://example.com/chart.png)", "A chart: https://example.com/chart.png"],
  ["[https://example.com](https://example.com)", "https://example.com"],
  ["[broken](missing", "[broken](missing"],
  ["**https://example.com/a_b**", "*https://example.com/a_b*"],
  ["`literal | pipe`", "`literal | pipe`"],
  [
    "HTTPS://example.com/__path__ www.example.com/__file__",
    "HTTPS://example.com/__path__ www.example.com/__file__",
  ],
])
  equal(`preserves ${JSON.stringify(input)}`, format(input), output);

section("tables become labeled rows without duplicate primary values");
const table =
  "| **Name** | Role | City |\n| :--- | ---: | :---: |\n| **Alice** | Admin | Cairo |\n| Bob | Member | Alexandria |";
equal(
  "renders structured table",
  format(table),
  "📋 *Alice*\n  • *Role:* Admin\n  • *City:* Cairo\n\n📋 *Bob*\n  • *Role:* Member\n  • *City:* Alexandria",
);
equal("preserves native output on another conversion", format(format(table)), format(table));
equal(
  "outer pipes optional",
  format("Name | Role\n--- | ---\nAlice | Admin"),
  "📋 *Alice*\n  • *Role:* Admin",
);
equal(
  "escaped and code pipes do not add cells",
  format("Name | Value\n--- | ---\nA\\|B | `x|y`"),
  "📋 *A|B*\n  • *Value:* `x|y`",
);
equal(
  "table parser handles literal pipes independently",
  parseMarkdownTable(["Name | Value", "--- | ---", "A\\|B | `x|y`"]).rows[0].length,
  2,
);
equal(
  "missing cells remain explicit",
  format("| Name | Value |\n| --- | --- |\n| A | |"),
  "📋 *A*\n  • *Value:* —",
);
equal(
  "one-column table is a simple list",
  format("| Name |\n| --- |\n| Alice |\n| Bob |"),
  "*Name*\n• Alice\n• Bob",
);
equal("empty table retains headers", format("| Name | Value |\n| --- | --- |"), "*Name* · *Value*");
equal(
  "header markup is not doubled",
  format("| Name | **Role** |\n| --- | --- |\n| A | **Admin** |"),
  "📋 *A*\n  • *Role:* *Admin*",
);
equal(
  "HTML line breaks in cells retain indentation",
  format("Name | Value\n--- | ---\nA | first<br>second"),
  "📋 *A*\n  • *Value:* first\n    second",
);
equal(
  "prose with pipes is not a table",
  format("Use A | B\nThis is normal prose."),
  "Use A | B\nThis is normal prose.",
);
equal("invalid delimiter is not a table", parseMarkdownTable(["A | B", "--- | nonsense"]), null);
const twoTables = format("A | B\n--- | ---\nx | y\nC | D\n--- | ---\nz | w");
ok(
  "adjacent tables keep both sets of headers",
  twoTables.includes("*B:* y") && twoTables.includes("*D:* w"),
);
withLang("en", () =>
  equal(
    "extra cells retain data with English labels",
    format("A | B\n--- | ---\nx | y | z"),
    "📋 *x*\n  • *B:* y\n  • *Column 3:* z",
  ),
);
withLang("ar", () =>
  ok(
    "empty titles use translated fallbacks",
    format("| A | B |\n| --- | --- |\n| | value |").includes("عنصر 1"),
  ),
);
const codeTable = `\`\`\`\n${table}\n\`\`\``;
equal("tables in code remain code", format(codeTable), codeTable);

section("real command dispatcher, raw newlines, reply envelopes and controls");
const agent = require("./src/services/aiAgent.cjs");
const router = require("./src/services/aiRouter.cjs");
const originalRun = agent.runAgent;
const originalProvider = router.getProvider;
let providerId = "gemini";
const rawAnswer = `**Answer**\n\n${table}`;
agent.runAgent = async () => ({
  text: rawAnswer,
  history: [{ role: "model", parts: [{ text: rawAnswer }] }],
});
router.getProvider = () => ({ id: providerId, label: providerId, isConfigured: () => true });
const { loadCommands, handleCommand, getCommandCatalog } = await import(
  "../src/handlers/command.handler.js"
);
await loadCommands();
const chat = "201111111111@s.whatsapp.net";
let sent;
const sock = {
  user: { id: chat },
  async sendMessage(jid, content, options) {
    sent.push({ jid, content, options });
    return { key: { id: "out", remoteJid: jid, fromMe: true } };
  },
  async sendPresenceUpdate() {},
};
async function run(body, message) {
  sent = [];
  const msg = {
    key: { id: "in", remoteJid: chat, fromMe: true },
    message: message || { conversation: body },
  };
  await handleCommand(sock, msg, body);
  return sent;
}
settings.set("bot_language", "en");
let replies = await run(`!md\n${table}`);
equal("newline after command is recognized", replies.length, 1);
equal("inline tables retain rows", replies[0]?.content.text, format(table));
ok(
  "formatter posts a reply rather than editing trigger",
  !replies[0]?.content.edit && replies[0]?.options.quoted?.key.id === "in",
);
replies = await run("!markdown **Hello** __world__");
equal("long alias shares conversion", replies[0]?.content.text, "*Hello* _world_");
replies = await run("!md", {
  ephemeralMessage: {
    message: {
      imageMessage: {
        caption: "!md",
        contextInfo: {
          quotedMessage: { ephemeralMessage: { message: { videoMessage: { caption: table } } } },
        },
      },
    },
  },
});
equal("quoted media captions unwrap correctly", replies[0]?.content.text, format(table));
replies = await run("!md **Inline**", {
  extendedTextMessage: {
    text: "!md **Inline**",
    contextInfo: { quotedMessage: { conversation: "**Quoted**" } },
  },
});
equal("inline text wins over quoted text", replies[0]?.content.text, "*Inline*");
replies = await run("!md\n```js\n  **literal**\n```");
equal("raw body keeps code indentation", replies[0]?.content.text, "```\n  **literal**\n```");
for (const lang of ["en", "ar"]) {
  settings.set("bot_language", lang);
  replies = await run("!md");
  ok(
    `${lang} missing input gives localized usage`,
    replies[0]?.content.text.includes(
      lang === "en" ? "Reply to a Markdown message" : "رد على رسالة",
    ),
  );
}
runtime.setPrefix(".");
replies = await run(".md");
ok("usage follows saved prefix", replies[0]?.content.text.includes(".md"));
replies = await run(".md\n**Text**");
equal("custom prefix retains multiline parsing", replies[0]?.content.text, "*Text*");
runtime.setEnabled("md", false);
replies = await run(".md **Blocked**");
ok("existing disabled-command gate applies", replies[0]?.content.text.includes("معطّل"));
runtime.setEnabled("md", true);
const catalog = getCommandCatalog().find((command) => command.name === "md");
equal("default access is MEMBERS", catalog?.permission, "MEMBERS");
ok(
  "dashboard catalog has both descriptions",
  Boolean(catalog?.descriptions.en && catalog?.descriptions.ar),
);
section("automatic AI delivery uses the same formatter, history stays raw");
runtime.setPrefix("!");
settings.set("bot_language", "en");
const history = require("./src/utils/storage-hub.cjs");
for (const id of ["gemini", "openai", "anthropic"]) {
  providerId = id;
  replies = await run("!gemini hi");
  equal(
    `${id} answer is formatted at send boundary`,
    replies.at(-1)?.content.text,
    format(rawAnswer),
  );
  const stored = await history.getChatHistoryAsync(chat);
  equal(`${id} model history is not reformatted`, stored.at(-1)?.parts[0].text, rawAnswer);
}
agent.runAgent = originalRun;
router.getProvider = originalProvider;
finish();
