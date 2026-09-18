// file: src/utils/markdownParser.cjs
//
// Converts standard Markdown output (especially from LLMs) into human-readable
// WhatsApp formatting:
//   - **bold** -> *bold*
//   - ~~strike~~ -> ~strike~
//   - __italic__ -> _italic_
//   - # Headings -> *Headings*
//   - Markdown tables (| col1 | col2 |) -> clean, itemized WhatsApp cards

/**
 * Parses markdown table text into structured data:
 * { headers: string[], rows: string[][] }
 */
function parseMarkdownTable(tableLines) {
  const cleanCells = (line) => {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  };

  if (tableLines.length < 2) return null;

  const headers = cleanCells(tableLines[0]);
  // Line 1 is usually the separator: |---|---|
  const separatorLine = tableLines[1];
  if (!/^[\s|:-]+$/.test(separatorLine)) return null;

  const rows = [];
  for (let i = 2; i < tableLines.length; i++) {
    const line = tableLines[i].trim();
    if (!line) continue;
    rows.push(cleanCells(line));
  }

  return { headers, rows };
}

/**
 * Formats parsed table data into a clean WhatsApp-friendly list of cards.
 */
function formatTableForWhatsApp({ headers, rows }) {
  if (!headers.length || !rows.length) return "";

  const cards = [];

  rows.forEach((row, rowIndex) => {
    const primaryLabel = row[0] || `عنصر ${rowIndex + 1}`;
    const fields = [];

    // If there's more than 1 column, list the remaining fields with bullet points
    if (headers.length > 1) {
      for (let c = 0; c < headers.length; c++) {
        const headerName = headers[c] || `عمود ${c + 1}`;
        const cellValue = row[c] || "—";
        fields.push(`  • *${headerName}:* ${cellValue}`);
      }
    } else {
      fields.push(`  • ${primaryLabel}`);
    }

    cards.push(`📋 *${primaryLabel}*\n${fields.join("\n")}`);
  });

  return cards.join("\n\n");
}

/**
 * Replaces markdown table blocks with WhatsApp-friendly formatted cards.
 */
function convertMarkdownTables(text) {
  const lines = text.split("\n");
  const output = [];
  let currentTable = [];

  const flushTable = () => {
    if (currentTable.length >= 2) {
      const parsed = parseMarkdownTable(currentTable);
      if (parsed) {
        output.push(formatTableForWhatsApp(parsed));
      } else {
        output.push(...currentTable);
      }
    } else {
      output.push(...currentTable);
    }
    currentTable = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      currentTable.push(line);
    } else {
      flushTable();
      output.push(line);
    }
  }
  flushTable();

  return output.join("\n");
}

/**
 * Main parser: converts standard Markdown to WhatsApp formatting.
 */
function formatMarkdownForWhatsApp(content) {
  if (!content || typeof content !== "string") return content;

  // 1. Protect code blocks and inline code using null-byte tokens
  const codeBlocks = [];
  let masked = content.replace(/```([\s\S]*?)```/g, (_, code) => {
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`\`\`\`${code}\`\`\``);
    return placeholder;
  });

  const inlineCodes = [];
  masked = masked.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `\x00INLINECODE${inlineCodes.length}\x00`;
    inlineCodes.push(`\`${code}\``);
    return placeholder;
  });

  // 2. Convert markdown tables into WhatsApp cards
  masked = convertMarkdownTables(masked);

  // 3. Convert Headings: # Heading -> *Heading*
  masked = masked.replace(/(^|\n|\s)(#{1,6})\s+([^\n]+)/g, (match, lead, hashes, title) => {
    return `${lead}*${title.trim()}*`;
  });

  // 4. Convert Strikethrough: ~~text~~ -> ~text~
  masked = masked.replace(/~~([^~\n]+)~~/g, "~$1~");

  // 5. Convert Bold: **text** -> *text*
  masked = masked.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");

  // 6. Convert Italic: __text__ -> _text_
  masked = masked.replace(/__([^_\n]+)__/g, "_$1_");

  // 7. Restore inline code and code blocks safely
  inlineCodes.forEach((code, idx) => {
    masked = masked.split(`\x00INLINECODE${idx}\x00`).join(code);
  });
  codeBlocks.forEach((block, idx) => {
    masked = masked.split(`\x00CODEBLOCK${idx}\x00`).join(block);
  });

  return masked;
}

module.exports = {
  formatMarkdownForWhatsApp,
  convertMarkdownTables,
  parseMarkdownTable,
};
