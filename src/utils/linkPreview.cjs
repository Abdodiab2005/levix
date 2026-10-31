// Baileys rc14 fetches preview pages/images through separate, unrestricted
// clients. Override its getUrlInfo hook instead of merely checking the first URL.
const settings = require("../config/settings.cjs");
const { fetchHttpsBuffer, httpsUrl } = require("./httpsFetch.cjs");
const { decodeBuffer, decodeText } = require("./textDecode.cjs");
const { withMediaThumbnail } = require("./thumbnail.cjs");
const logger = require("./logger.cjs");

function pageMetadata(html) {
  const meta = new Map();
  // Only read metadata; never render HTML, run scripts, or follow refresh/base
  // tags. Bound the input at the transport and each attribute at extraction.
  const head = html
    .slice(0, 128 * 1024)
    .split(/<\/head\s*>/i, 1)[0]
    .replace(/<!--[\s\S]*?-->/g, "");
  // Bounded tag scans also bound work on malformed, attacker-controlled HTML.
  for (const tag of head.match(/<meta\b[^>]{0,8192}>/gi) || []) {
    const attrs = new Map();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(
        match[1].toLowerCase(),
        decodeText((match[2] ?? match[3] ?? match[4]).slice(0, 4096)),
      );
    }
    const key = (attrs.get("property") || attrs.get("name") || "").toLowerCase();
    if (!meta.has(key)) meta.set(key, attrs.get("content") || "");
  }
  const titleStart = /<title\b[^>]{0,512}>/i.exec(head);
  const titleText = titleStart
    ? head
        .slice(
          titleStart.index + titleStart[0].length,
          titleStart.index + titleStart[0].length + 4096,
        )
        .split(/<\/title\s*>/i, 1)[0]
    : "";
  const title = meta.get("og:title") || meta.get("twitter:title") || decodeText(titleText);
  return {
    title: title
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 512),
    description: (meta.get("og:description") || meta.get("description") || "").slice(0, 2048),
    image: meta.get("og:image:secure_url") || meta.get("og:image") || meta.get("twitter:image"),
  };
}

async function getHttpsUrlInfo(text, { dispatcher } = {}) {
  if (!settings.get("link_previews_enabled")) return undefined;
  try {
    const url = httpsUrl(/^[\w+.-]+:\/\//.test(text) ? text : `https://${text}`);
    const page = await fetchHttpsBuffer(url.href, {
      maxBytes: 1024 * 1024,
      timeoutMs: 3000,
      dispatcher,
    });
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) return undefined;
    const metadata = pageMetadata(decodeBuffer(page.buffer, page.contentType));
    if (!metadata.title) return undefined;
    const info = {
      "canonical-url": page.url,
      "matched-text": text,
      title: metadata.title,
      description: metadata.description,
    };
    if (metadata.image) {
      try {
        const imageUrl = httpsUrl(metadata.image, page.url);
        const image = await fetchHttpsBuffer(imageUrl.href, {
          maxBytes: 2 * 1024 * 1024,
          timeoutMs: 3000,
          dispatcher,
        });
        if (/^image\//i.test(image.contentType)) {
          const content = await withMediaThumbnail({ image: image.buffer });
          info.jpegThumbnail = content.jpegThumbnail;
        }
      } catch {
        // A refused or failed image must not discard safe page metadata.
      }
    }
    return info;
  } catch (err) {
    logger.debug({ err: err?.message }, "[linkPreview] preview skipped");
    return undefined; // Baileys sends the text without an unsafe fallback
  }
}

module.exports = { getHttpsUrlInfo };
