// Markdown from any provider -> WhatsApp text. This is a display boundary:
// stored AI history, code contents, identifiers and URLs remain untouched.
const { t } = require("./i18n.cjs");

/** Split table cells without splitting escaped pipes or pipes inside code. */
function tableCells(line) {
  const cells = [];
  let cell = "";
  let ticks = 0;
  const text = line.trim();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (text[i] === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      const run = end - i;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += text.slice(i, end);
      i = end - 1;
    } else if (text[i] === "|" && !ticks) {
      cells.push(cell.trim());
      cell = "";
    } else cell += text[i];
  }
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells;
}

function parseMarkdownTable(lines) {
  if (lines.length < 2 || !lines[0].includes("|")) return null;
  const headers = tableCells(lines[0]);
  const separators = tableCells(lines[1]);
  if (
    !headers.length ||
    headers.length !== separators.length ||
    !separators.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  return { headers, rows: lines.slice(2).map(tableCells) };
}

function bold(value) {
  // The whole heading/label is bold; flatten inner bold spans before wrapping.
  const text = value.trim().replace(/\*([^*\n]+)\*/g, "$1");
  return `*${text}*`;
}

function tableText({ headers, rows }) {
  if (!rows.length) return headers.map(bold).join(" · ");
  if (headers.length === 1 && rows.every((row) => row.length <= 1)) {
    return `${bold(headers[0])}\n${rows.map((row) => `• ${row[0] || "—"}`).join("\n")}`;
  }
  return rows
    .map((row, index) => {
      const title = row[0] || t("bot.core.markdownParser.item", { number: index + 1 });
      const fields = [];
      for (let c = 1; c < Math.max(headers.length, row.length); c++) {
        const header = headers[c] || t("bot.core.markdownParser.column", { number: c + 1 });
        const label = header.replace(/^\*([^*]+)\*$/, "$1");
        const value = (row[c] || "—").replace(/<br\s*\/?>/gi, "\n");
        fields.push(`  • ${bold(`${label}:`)} ${value.replace(/\n/g, "\n    ")}`);
      }
      return `📋 ${bold(title)}\n${fields.join("\n")}`;
    })
    .join("\n\n");
}

/** Only a header followed by a real delimiter row starts a table. */
function convertMarkdownTables(text) {
  const lines = text.split("\n");
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseMarkdownTable(lines.slice(i, i + 2));
    if (!parsed) {
      output.push(lines[i]);
      continue;
    }
    i += 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
      // A second header/delimiter pair belongs to a separate table.
      if (parseMarkdownTable(lines.slice(i, i + 2))) break;
      parsed.rows.push(tableCells(lines[i++]));
    }
    i--;
    output.push(tableText(parsed));
  }
  return output.join("\n");
}

function shieldCode(text, store) {
  const runs = /`+|~{3,}/g;
  let output = "";
  let cursor = 0;
  for (let match = runs.exec(text); match; match = runs.exec(text)) {
    const marker = match[0];
    const start = match.index;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", runs.lastIndex);
    const info = lineEnd < 0 ? "" : text.slice(runs.lastIndex, lineEnd);
    const fenced =
      marker.length >= 3 &&
      lineEnd >= 0 &&
      /^ {0,3}$/.test(text.slice(lineStart, start)) &&
      !info.includes(marker[0]);
    let rendered;
    let end;
    if (fenced) {
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "gm");
      close.lastIndex = lineEnd + 1;
      const ending = close.exec(text);
      let body = text.slice(lineEnd + 1, ending ? ending.index : text.length);
      if (ending && body.endsWith("\n")) body = body.slice(0, -1);
      rendered = `\`\`\`\n${body}\n\`\`\``;
      end = ending ? ending.index + ending[0].length : text.length;
    } else {
      if (marker[0] !== "`") continue;
      const close = new RegExp(`(?<!\`)\`{${marker.length}}(?!\`)`, "g");
      close.lastIndex = runs.lastIndex;
      const ending = close.exec(text);
      if (!ending) continue;
      end = ending.index + marker.length;
      rendered =
        marker.length === 2
          ? `\`\`\`${text.slice(runs.lastIndex, ending.index)}\`\`\``
          : text.slice(start, end);
    }
    output += text.slice(cursor, start) + store(rendered);
    cursor = end;
    runs.lastIndex = end;
  }
  return output + text.slice(cursor);
}

function links(text, store) {
  let output = "";
  let cursor = 0;
  let skipUntil = 0;
  for (const match of text.matchAll(/!?\[([^[\]\n]*)\]\(/g)) {
    if (match.index < cursor || match.index < skipUntil) continue;
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length && text[end] !== "\n"; end++) {
      if (text[end] === "\\") {
        end++;
        continue;
      }
      if (text[end] === "(") depth++;
      if (text[end] === ")" && --depth === 0) break;
    }
    if (depth) {
      skipUntil = end;
      continue;
    }
    const destination = text.slice(start, end).match(/^<?(\S+?)>?(?:[ \t]+["'][\s\S]*["'])?$/)?.[1];
    if (!destination) continue;
    const name = match[1].trim();
    output +=
      text.slice(cursor, match.index) +
      (name && name !== destination ? `${name}: ` : "") +
      store(destination);
    cursor = end + 1;
  }
  return output + text.slice(cursor);
}

function formatMarkdownForWhatsApp(content) {
  if (typeof content !== "string" || !content) return content;
  // Pick an unused namespace: user text resembling a placeholder is not lost.
  let prefix = "\x00WA";
  while (content.includes(prefix)) prefix += "X";
  const saved = [];
  const store = (text) => `${prefix}${saved.push(text) - 1}\x00`;
  let text = shieldCode(content.replace(/\r\n?/g, "\n"), store);
  text = links(text, store);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Stop URLs before internal shielding tokens.
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>\x00]+/gi, (url, offset, source) => {
    for (const marker of ["***", "**", "__", "~~", "*", "_"]) {
      if (source.slice(0, offset).endsWith(marker) && url.endsWith(marker)) {
        return store(url.slice(0, -marker.length)) + marker;
      }
    }
    return store(url);
  });
  text = text.replace(/\\([\\`*{}[\]()#+.!_>~|-])/g, (_, literal) => store(literal));
  text = text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "*_$1_*")
    .replace(/(?<![\p{L}\p{N}_])___([^_\n]+)___(?![\p{L}\p{N}_])/gu, "*_$1_*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, "_$1_")
    .replace(/~~([^~\n]+)~~/g, "~$1~");
  text = convertMarkdownTables(text);
  const lines = text.split("\n");
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) line = bold(heading[1]);
    else if (
      line.trim() &&
      !line.includes(prefix) &&
      /^ {0,3}(?:={3,}|-{3,})[ \t]*$/.test(lines[i + 1] || "")
    ) {
      line = bold(line);
      i++;
    } else if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      line = "──────────";
    } else {
      line = line
        .replace(
          /^(\s*)[-+*][ \t]+\[([ xX])\][ \t]+/,
          (_, indent, check) => `${indent}${check === " " ? "☐" : "☑"} `,
        )
        .replace(/^(\s*)[-+*][ \t]+/, "$1• ")
        .replace(/^(\s*)(\d+)\)[ \t]+/, "$1$2. ")
        .replace(/^ {0,3}(?:>[ \t]*)+/, "> ");
    }
    output.push(line.replace(/[ \t]+$/, ""));
  }
  text = output.join("\n");
  // A link can contain an already-protected code label, so restore inside out.
  const token = new RegExp(`${prefix}(\\d+)\x00`, "g");
  const restore = (whole, id) => saved[id]?.replace(token, restore) ?? whole;
  text = text.replace(token, restore);
  return text;
}

module.exports = { formatMarkdownForWhatsApp, convertMarkdownTables, parseMarkdownTable };
