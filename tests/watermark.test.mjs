// Phase 09 exclusions and Phase 08 optional extension hook. No network or pairing.
import { equal, ok, finish, require, section, useTempDataDir } from "./harness.mjs";
useTempDataDir("levix-watermark");
const settings = require("./src/config/settings.cjs");
const { withLang, t } = require("./src/utils/i18n.cjs");
const {
  stampWatermark,
  createMessage,
  renderMessage,
  EXACT_OUTPUT,
} = require("./src/messaging/message.cjs");
const { host } = require("./src/extensions/host.cjs");

section("Free behavior and exclusions");
equal("new Free installs keep default off", settings.get("message_watermark"), false);
equal("default does not stamp", stampWatermark("Free result"), "Free result");
settings.set("message_watermark", true);
for (const lang of ["en", "ar", "pt-BR", "es-419"]) {
  withLang(lang, () => {
    const mark = t("bot.core.message.watermark");
    const marked = stampWatermark("A result", { commandName: "weather" });
    equal(`${lang} opt-in mark`, marked, `A result\n${mark}`);
    equal(`${lang} no duplicate`, stampWatermark(marked), marked);
    for (const name of EXACT_OUTPUT)
      equal(
        `${lang} exact ${name}`,
        stampWatermark("unchanged", { commandName: name }),
        "unchanged",
      );
    for (const category of ["error", "progress", "security", "system"]) {
      equal(`${lang} category ${category}`, stampWatermark("unchanged", { category }), "unchanged");
    }
    equal(`${lang} explicit exact`, stampWatermark("unchanged", { exact: true }), "unchanged");
    equal(`${lang} overlength unchanged`, stampWatermark("x".repeat(4096)), "x".repeat(4096));
    equal(`${lang} boundary fits`, stampWatermark("x".repeat(4096 - mark.length - 1)).length, 4096);
    const secret = createMessage({ messageKey: "bot.core.ping.pong", sensitivity: "secret" });
    ok(`${lang} secret envelope`, !renderMessage(secret).includes(mark));
  });
}
for (const name of ["stt", "send", "shortlink"])
  ok(`${name} explicitly excluded`, EXACT_OUTPUT.has(name));

section("optional Plus integration");
const hide = host.hideWatermark;
try {
  host.hideWatermark = () => false;
  ok("absent/inactive Plus leaves Free opt-in effective", stampWatermark("result") !== "result");
  host.hideWatermark = () => true;
  equal("active host hide hook removes mark", stampWatermark("result"), "result");
  settings.set("message_watermark", false);
  host.hideWatermark = () => false;
  equal("Plus removal never enables Free watermark", stampWatermark("result"), "result");
} finally {
  host.hideWatermark = hide;
}
finish();
