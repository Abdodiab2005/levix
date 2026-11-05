// Command Engine v2 parser.
//
// One pure function turns the text of a message into a command invocation.
// It does not load commands, check permissions, or send anything. The
// dispatcher does that, so a new command such as `!update` (Phase 09) needs
// no parser change: a well-formed name comes out and the registry decides.
//
// v1 is the previous split, kept behind the `command_parser` setting for one
// release. Rollback switches the setting. It does not grow a second sender.

const NAME_MAX = 32;

function hasDisallowedChar(token) {
  for (const char of token) {
    const code = char.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (char === "\\" || char === "/" || char === "." || char === ":" || char === "`") return true;
  }
  return false;
}

/**
 * A token that can be a command name or an alias.
 * Letters (any language), digits, `_` and `-`, plus the one shipped alias `=`.
 * Slashes, dots and colons are rejected so a URL or a path after the prefix
 * is ordinary text, not a command.
 * @param {string} token
 */
function isCommandName(token) {
  if (!token || token.length > NAME_MAX) return false;
  if (hasDisallowedChar(token)) return false;
  if (token === "=") return true;
  return /^[\p{L}\p{N}_-]+$/u.test(token);
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {{kind: "not-command"}|{kind: "empty"}|{kind: "command", name: string, args: string[], rawRemainder: string}}
 */
function parseCommandText(body, { prefix = "!" } = {}) {
  if (typeof body !== "string" || !prefix || !body.startsWith(prefix)) {
    return { kind: "not-command" };
  }

  const rest = body.slice(prefix.length);
  // A newline between the command and the next word is a separator, the same
  // way a space is. Leading whitespace after the prefix is that separator.
  const trimmed = rest.replace(/^\s+/, "");
  if (!trimmed) return { kind: "empty" };

  const nameMatch = /^\S+/.exec(trimmed);
  const rawName = nameMatch ? nameMatch[0] : "";
  if (!isCommandName(rawName)) return { kind: "not-command" };

  const afterName = trimmed.slice(rawName.length);
  // Drop only the separator before the arguments. Newlines inside the
  // arguments stay in rawRemainder so a command can keep a paragraph.
  const rawRemainder = afterName.replace(/^[ \t\r\n]+/, "");
  const args = rawRemainder ? rawRemainder.split(/\s+/).filter(Boolean) : [];

  return {
    kind: "command",
    name: rawName.toLowerCase(),
    args,
    rawRemainder,
  };
}

/** The v4 splitter: any first token, unknown names included. */
function parseCommandTextV1(body, { prefix = "!" } = {}) {
  if (typeof body !== "string" || !prefix || !body.startsWith(prefix)) {
    return { kind: "not-command" };
  }
  const parts = body.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { kind: "empty" };
  const rawName = parts.shift();
  return {
    kind: "command",
    name: String(rawName).toLowerCase(),
    args: parts,
    rawRemainder: parts.join(" "),
  };
}

module.exports = { isCommandName, parseCommandText, parseCommandTextV1 };
