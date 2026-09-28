// Long-term memory: what the model actually gets in its system instruction.
//
// The dashboard memory editor writes free-form Markdown, and the agent's
// save_memory tool writes `-` entries with metadata in HTML comments. Both
// shapes must reach the model — an editor edit that the bot never reads is
// the bug this file pins down.

import { useTempDataDir, require, ok, equal, section, finish } from "./harness.mjs";

useTempDataDir("memory");

const memory = require("./src/utils/memory.cjs");
const fs = require("node:fs");
const path = require("node:path");

section("memory file plumbing");

memory.ensureDirs();
ok("memory root exists", fs.existsSync(memory.ROOT));

memory.addMemory({ scope: "chat", chatId: "120363-test@g.us", content: "صاحب الجروب اسمه عمر" });
memory.addMemory({ scope: "global", content: "الطفل بيتكلم عربي وإنجليزي" });
equal(
  "addMemory returns an id",
  typeof memory.addMemory({ scope: "global", content: "another fact" }).id,
  "string",
);

section("buildMemoryContext injects what the operator and the bot wrote");

const context = memory.buildMemoryContext("120363-test@g.us");

ok("bot-saved entries reach the model", context.includes("صاحب الجروب اسمه عمر"));
ok("global entries reach the model", context.includes("الطفل بيتكلم عربي وإنجليزي"));
ok("scopes are labelled", context.includes("global.md"));

// The hand-editing contract: prose written from the panel is part of memory.
const globalFile = memory.GLOBAL_FILE;
fs.writeFileSync(
  globalFile,
  [
    "# 🧠 الذاكرة العامة",
    "",
    "> معلومات محفوظة لكل المحادثات. ملف Markdown عادي — عدّله بإيدك وقت ما تحب.",
    "> كل سطر بيبدأ بـ `-` هو معلومة محفوظة.",
    "",
    "The operator wrote this paragraph by hand from the dashboard editor.",
    "- a bot entry <!-- id:mabc123 at:2026-09-27T00:00:00.000Z -->",
    "",
  ].join("\n"),
  "utf8",
);

const handEdited = memory.buildMemoryContext("120363-test@g.us");
ok(
  "hand-written prose reaches the model",
  handEdited.includes("The operator wrote this paragraph by hand from the dashboard editor."),
);
ok("bot entries still reach the model after a hand edit", handEdited.includes("a bot entry"));
ok("entry metadata comments are stripped", !handEdited.includes("id:mabc123"));
ok("file header is not injected", !handEdited.includes("الذاكرة العامة"));
ok("editor notes are not injected", !handEdited.includes("عدّله بإيدك وقت ما تحب"));

section("budget");

const tiny = memory.buildMemoryContext("120363-test@g.us", { limitChars: 60 });
ok("tiny budget produces a short block", tiny.length < 400 && tiny.length > 0);
ok(
  "a chat with no memory file of its own gets only the global block",
  memory.buildMemoryContext("9999-never-seen@g.us").includes("global.md") &&
    !memory.buildMemoryContext("9999-never-seen@g.us").includes("chats/"),
);

section("scopes stay separate");

// global.md was rewritten above, so the chat file carries the only remaining
// entry for that chat — and the chat id picks exactly that file.
const chatFile = memory.memoryFilePath("chat", "120363-test@g.us");
ok("chat file path lives under chats/", path.dirname(chatFile).endsWith("chats"));
ok(
  "chat file exists on disk",
  fs.existsSync(chatFile) && fs.readFileSync(chatFile, "utf8").includes("عمر"),
);

ok("removeMemory drops a matching entry", memory.removeMemory({ scope: "chat", chatId: "120363-test@g.us", ref: "عمر" }) !== null);
ok(
  "removed entry is gone",
  !memory
    .buildMemoryContext("120363-test@g.us")
    .includes("صاحب الجروب اسمه عمر"),
);

finish();
