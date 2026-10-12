// The diagnostics text sanitizer (contract section 4).
//
// The rules are read one at a time: a JID, an e-mail, a phone number, a URL's
// path, an API key, an install path and the user's home each have to disappear
// from a string that is about to be stored or sent.

import os from "node:os";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-sanitize");

const { sanitizeText } = require("./src/diagnostics/sanitize.cjs");
const { DATA_DIR } = require("./src/config/paths.cjs");

section("identities never survive");

equal(
  "a phone JID becomes <jid>",
  sanitizeText("contact 201234567890@s.whatsapp.net now"),
  "contact <jid> now",
);
equal("a group JID becomes <jid>", sanitizeText("120363000000000001@g.us"), "<jid>");
equal("a LID becomes <jid>", sanitizeText("abc123@lid"), "<jid>");
equal("a broadcast JID becomes <jid>", sanitizeText("x@broadcast"), "<jid>");
equal("an e-mail becomes <email>", sanitizeText("write me@example.com"), "write <email>");
ok(
  "the original identity is gone",
  !sanitizeText("201234567890@s.whatsapp.net me@example.com").includes("@"),
);

section("numbers, URLs, secrets and paths");

equal("a long phone number becomes <number>", sanitizeText("call +201234567890"), "call <number>");
equal("a bare seven-digit run becomes <number>", sanitizeText("id 1234567"), "id <number>");
equal("six digits are left alone", sanitizeText("pin 123456"), "pin 123456");
equal(
  "a long all-digit run is a number, not a secret",
  sanitizeText("1234567890123456789012345"),
  "<number>",
);
equal(
  "a URL keeps its scheme and host only",
  sanitizeText("see https://example.com/a/b?token=abcdef now"),
  "see https://example.com/<path> now",
);
ok(
  "the query string is dropped",
  !sanitizeText("https://example.com/a?token=supersecret").includes("supersecret"),
);
equal(
  "a host without a path is untouched",
  sanitizeText("https://example.com"),
  "https://example.com",
);
equal(
  "a 24-char token becomes <secret>",
  sanitizeText("key aBcDeFgHiJkLmNoPqRsTuVwX"),
  "key <secret>",
);
equal(
  "a path inside the data directory becomes <data>",
  sanitizeText(`${DATA_DIR}/crash-reports/9f2c.json`),
  "<data>/crash-reports/9f2c.json",
);
equal(
  "the home directory becomes ~",
  sanitizeText(`${os.homedir()}/notes/todo.md`),
  "~/notes/todo.md",
);

section("control characters and caps");

equal("control characters are removed", sanitizeText("a\u0000b\u0007c"), "abc");
ok("the result is trimmed", sanitizeText("  padded  ") === "padded");
equal("the cap is applied after sanitizing", sanitizeText("word ".repeat(200), 10).length, 10);
equal("the cap is a hard slice", sanitizeText("abcdefghij", 4), "abcd");

section("what must never be collected");

const wire = sanitizeText(
  `${DATA_DIR}/x 201234567890@s.whatsapp.net me@example.com +201234567890 https://h/p?q=aBcDeFgHiJkLmNoPqRsTuVwX aBcDeFgHiJkLmNoPqRsTuVwX /home/${os.userInfo().username}/secret`,
);
ok("no JID survives", !wire.includes("@s.whatsapp.net"));
ok("no e-mail survives", !wire.includes("me@example.com"));
ok("no long digit run survives", !/\d{7,}/.test(wire));
ok("no token survives", !wire.includes("aBcDeFgHiJkLmNoPqRsTuVwX"));

finish();
