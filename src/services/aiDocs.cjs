// A literal JSON require also embeds the index in SEA. No user-supplied paths.
const index = require("./levix-docs.generated.json");
const version = require("../../package.json").version;
const LANGUAGES = ["en", "ar", "pt-BR", "es-419"];
const SOURCES = [
  "README.md",
  "SETUP.md",
  "ANDROID.md",
  "PRIVACY.md",
  ...LANGUAGES.map((language) => `i18n/${language}/commands.json`),
];
const MAX_SECTION_CHARS = 4000;

function validateIndex(value, expectedVersion = version) {
  if (!value || value.schema !== 1 || value.version !== expectedVersion)
    throw new Error("Bundled documentation is unavailable for this release");
  if (
    !Array.isArray(value.sources) ||
    value.sources.length !== SOURCES.length ||
    new Set(value.sources.map((source) => source.file)).size !== SOURCES.length ||
    value.sources.some(
      (source) => !SOURCES.includes(source.file) || !/^[a-f0-9]{64}$/.test(source.sha256),
    ) ||
    !Array.isArray(value.sections) ||
    !value.sections.length ||
    value.sections.length > 2000 ||
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
  )
    throw new Error("Invalid bundled documentation index");
  const ids = new Set();
  for (const section of value.sections) {
    const locale =
      typeof section.source === "string" && section.source.startsWith("i18n/")
        ? section.source.split("/")[1]
        : "en";
    if (
      !SOURCES.includes(section.source) ||
      section.locale !== locale ||
      typeof section.id !== "string" ||
      section.id.length > 240 ||
      !section.id.startsWith(`${section.source}#`) ||
      ids.has(section.id) ||
      typeof section.title !== "string" ||
      section.title.length > 160 ||
      typeof section.text !== "string" ||
      !section.text ||
      section.text.length > MAX_SECTION_CHARS
    )
      throw new Error("Invalid bundled documentation section");
    ids.add(section.id);
  }
  return value;
}

function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[أإآ]/g, "ا");
}

// Lexical bridges for English prose; the command reference is localized.
const TOPICS = [
  [
    "backup restore",
    "backup",
    "restore",
    "احتياط",
    "نسخة",
    "نسخه",
    "استعاد",
    "restaur",
    "copia",
    "seguridad",
  ],
  [
    "password recovery reset",
    "password",
    "كلمة المرور",
    "كلمه المرور",
    "senha",
    "contrasena",
    "recuper",
  ],
  ["proxy whatsapp", "proxy", "بروكسي", "وكيل"],
  ["battery background", "battery", "بطاري", "الخلفية", "الخلفيه", "bateria", "segundo plano"],
  ["setup install", "setup", "install", "تثبيت", "اعداد", "instal", "configur"],
  ["language", "language", "لغة", "لغه", "idioma", "lingua"],
  ["permission roles", "permission", "صلاح", "اذن", "permis", "funcao"],
  ["terms consent", "consent", "terms", "شروط", "موافق", "termos", "terminos", "consentim"],
  ["privacy", "privacy", "خصوص", "privacidade", "privacidad"],
  ["sticker", "sticker", "ملصق", "figurinha", "pegatina"],
  ["transcribe voice speech", "transcri", "تفريغ", "صوت", "voz", "audio"],
];
const STOP = new Set(
  "how do i a an the to is are can does have levix me my this what about please como de la el en un una que eu o os as e y هل كيف ما من في على عن اعمل هذا".split(
    " ",
  ),
);

function metadata(section, requestedLanguage) {
  return {
    id: section.id,
    source: section.source,
    title: section.title,
    version,
    locale: section.locale,
    requestedLanguage,
    fallback: section.locale !== requestedLanguage,
    citation: `${section.source} § ${section.title} (Levix ${version}, ${section.locale})`,
  };
}

function searchDocs({ query, language = "en", limit = 3 } = {}) {
  validateIndex(index);
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 300 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5 ||
    typeof language !== "string"
  )
    throw new Error("Docs search requires a query of 1–300 characters and limit 1–5");
  const requested = LANGUAGES.includes(language) ? language : "en";
  const normalized = normalize(query);
  const terms = new Set(
    normalized.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOP.has(word)),
  );
  for (const [expansion, ...matches] of TOPICS) {
    if (matches.some((match) => normalized.includes(normalize(match))))
      for (const word of expansion.split(" ")) terms.add(word);
  }
  const ranked = [];
  for (const section of index.sections) {
    if (section.locale !== requested && section.locale !== "en") continue;
    const title = normalize(section.title);
    const text = normalize(section.text);
    let score = 0;
    for (const term of terms) score += title.includes(term) ? 6 : text.includes(term) ? 1 : 0;
    if (score) ranked.push({ section, score: score + (section.locale === requested ? 2 : 0) });
  }
  ranked.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id, "en"));
  const seen = new Set();
  const results = [];
  for (const { section } of ranked) {
    const key = section.source.startsWith("i18n/") ? section.title : section.id;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...metadata(section, requested), excerpt: section.text.slice(0, 450) });
    if (results.length >= limit) break;
  }
  return { version, untrustedData: true, results };
}

function openDocSection({ id } = {}) {
  validateIndex(index);
  if (typeof id !== "string" || id.length > 240)
    throw new Error("A documentation section ID is required");
  const section = index.sections.find((item) => item.id === id);
  if (!section) throw new Error("Section not found in this release's bundled documentation");
  return { ...metadata(section, section.locale), untrustedData: true, text: section.text };
}

// Cite only IDs that exist in the bundled index, never a model-supplied URL or title.
function docSourcesFromTool(name, result) {
  if (result?.error || result?.version !== version) return [];
  const ids =
    name === "search_levix_docs"
      ? result.results?.map((item) => item.id)
      : name === "open_levix_doc_section"
        ? [result.id]
        : [];
  if (!Array.isArray(ids)) return [];
  return ids.slice(0, 5).flatMap((id) => {
    const section = index.sections.find((item) => item.id === id);
    return section
      ? [{ kind: "levix-doc", id, citation: metadata(section, section.locale).citation }]
      : [];
  });
}

module.exports = {
  searchDocs,
  openDocSection,
  validateIndex,
  docSourcesFromTool,
  MAX_SECTION_CHARS,
};
