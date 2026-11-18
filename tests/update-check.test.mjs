// tests/update-check.test.mjs
// Regressions and contract tests for Phase 09 update checking, official links,
// SemVer comparison, and !update command integration.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-update-check");

const officialLinks = require("./src/config/official-links.cjs");
const updateCheck = require("./src/services/updateCheck.cjs");
const updateCommand = require("./src/commands/update.cjs");

section("official-links: constants and freezing");

{
  const { LINKS } = officialLinks;
  ok("LINKS is frozen", Object.isFrozen(LINKS));
  equal("website link", LINKS.website, "https://levix.leviro.net");
  equal("docs link", LINKS.docs, "https://levix.leviro.net/docs");
  equal("github link", LINKS.github, "https://github.com/Abdodiab2005/levix");
  equal("releases link", LINKS.releases, "https://github.com/Abdodiab2005/levix/releases");
  equal("play link", LINKS.play, "https://play.google.com/store/apps/details?id=net.leviro.levix");
  equal("studio link", LINKS.studio, "https://leviro.net");
  equal("portfolio link", LINKS.portfolio, "https://abdelrhman.leviro.net");
  equal("support link", LINKS.support, "https://levix.leviro.net/feedback");
}

section("official-links: safeOfficialUrl");

{
  const { safeOfficialUrl, LINKS } = officialLinks;

  for (const [name, url] of Object.entries(LINKS)) {
    ok(`accepts fixed link ${name}`, safeOfficialUrl(url));
  }

  ok(
    "accepts release detail tag",
    safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0"),
  );
  ok(
    "accepts beta release detail tag",
    safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/5.0.0-beta.1"),
  );
  ok(
    "accepts build metadata release detail tag",
    safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/5.0.0+android.69"),
  );

  // Security rejections
  ok(
    "rejects credentials in URL",
    !safeOfficialUrl("https://user:pass@github.com/Abdodiab2005/levix/releases"),
  );
  ok(
    "rejects non-standard port",
    !safeOfficialUrl("https://github.com:8443/Abdodiab2005/levix/releases"),
  );
  ok(
    "rejects URL with hash",
    !safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0#frag"),
  );
  ok(
    "rejects URL with search params",
    !safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0?foo=bar"),
  );
  ok("rejects HTTP scheme", !safeOfficialUrl("http://levix.leviro.net"));
  ok("rejects javascript scheme", !safeOfficialUrl("javascript:alert(1)"));
  ok(
    "rejects attacker lookalike host",
    !safeOfficialUrl("https://evil-github.com/Abdodiab2005/levix/releases/tag/v5.0.0"),
  );
  ok(
    "rejects other repository path",
    !safeOfficialUrl("https://github.com/attacker/repo/releases/tag/v5.0.0"),
  );
  ok(
    "rejects directory traversal in tag",
    !safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/../v5.0.0"),
  );
  ok(
    "rejects malformed tag",
    !safeOfficialUrl("https://github.com/Abdodiab2005/levix/releases/tag/not-a-version"),
  );
  ok("rejects null", !safeOfficialUrl(null));
  ok("rejects empty string", !safeOfficialUrl(""));
  ok("rejects non-string", !safeOfficialUrl(12345));
}

section("official-links: releaseDetailUrl");

{
  const { releaseDetailUrl } = officialLinks;
  equal(
    "valid tag generates detail URL",
    releaseDetailUrl("v5.0.0"),
    "https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0",
  );
  equal(
    "valid prerelease tag generates detail URL",
    releaseDetailUrl("5.0.0-beta.1"),
    "https://github.com/Abdodiab2005/levix/releases/tag/5.0.0-beta.1",
  );
  equal("invalid tag returns null", releaseDetailUrl("not-valid-semver"), null);
  equal("empty tag returns null", releaseDetailUrl(""), null);
  equal("non-string returns null", releaseDetailUrl(null), null);
}

section("getInstallChannel");

{
  const { getInstallChannel } = updateCheck;

  equal(
    "play channel detected strictly with env and argv",
    getInstallChannel({ LEVIX_ANDROID: "1" }, ["node", "levix", "--levix-play-install"]),
    "play",
  );
  equal(
    "missing env returns github",
    getInstallChannel({}, ["node", "levix", "--levix-play-install"]),
    "github",
  );
  equal(
    "missing argv flag returns github",
    getInstallChannel({ LEVIX_ANDROID: "1" }, ["node", "levix"]),
    "github",
  );
  equal(
    "default CLI execution returns github",
    getInstallChannel({}, ["node", "bin/levix.js"]),
    "github",
  );
}

section("SemVer parser and comparator");

{
  const { parseSemVer, compareSemVer } = updateCheck;

  const v1 = parseSemVer("1.2.3");
  equal("parse simple major", v1.major, 1n);
  equal("parse simple minor", v1.minor, 2n);
  equal("parse simple patch", v1.patch, 3n);
  equal("parse simple prerelease is null", v1.prerelease, null);

  const vBeta = parseSemVer("v5.0.0-beta.1+android.69");
  equal("parse stripped v major", vBeta.major, 5n);
  equal("parse prerelease array length", vBeta.prerelease.length, 2);
  equal("parse prerelease segment 0", vBeta.prerelease[0], "beta");
  equal("parse prerelease segment 1", vBeta.prerelease[1], "1");
  equal("parse build metadata segment", vBeta.build[0], "android");

  equal("invalid semver returns null", parseSemVer("1.2"), null);
  equal("leading zero rejected", parseSemVer("01.2.3"), null);
  equal("empty string returns null", parseSemVer(""), null);

  // Comparator tests
  equal("equal versions", compareSemVer("1.0.0", "1.0.0"), 0);
  equal("higher major", compareSemVer("2.0.0", "1.9.9"), 1);
  equal("lower minor", compareSemVer("1.2.0", "1.3.0"), -1);
  equal("higher patch", compareSemVer("1.0.2", "1.0.1"), 1);

  // Prerelease precedence: normal version > prerelease version
  equal("normal > prerelease", compareSemVer("1.0.0", "1.0.0-alpha"), 1);
  equal("prerelease < normal", compareSemVer("1.0.0-alpha", "1.0.0"), -1);

  // Prerelease dot-identifier comparison
  equal("beta.2 > beta.1", compareSemVer("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  equal("beta.11 > beta.2 numeric comparison", compareSemVer("1.0.0-beta.11", "1.0.0-beta.2"), 1);
  equal("numeric < non-numeric", compareSemVer("1.0.0-1", "1.0.0-alpha"), -1);
  equal(
    "shorter prerelease < longer prerelease",
    compareSemVer("1.0.0-alpha", "1.0.0-alpha.1"),
    -1,
  );

  // Build metadata ignored
  equal("build metadata ignored", compareSemVer("1.0.0+build1", "1.0.0+build2"), 0);
}

section("SemVer candidate eligibility");

{
  const { isEligibleCandidate } = updateCheck;

  // Stable installations:
  ok("stable sees newer stable", isEligibleCandidate("5.0.1", "5.0.0"));
  ok("stable never sees prerelease", !isEligibleCandidate("5.1.0-alpha.1", "5.0.0"));
  ok("stable never sees same version", !isEligibleCandidate("5.0.0", "5.0.0"));
  ok("stable never sees older version", !isEligibleCandidate("4.9.0", "5.0.0"));

  // Prerelease installations:
  ok("beta sees newer same-base beta", isEligibleCandidate("5.0.0-beta.2", "5.0.0-beta.1"));
  ok("beta sees stable of same base", isEligibleCandidate("5.0.0", "5.0.0-beta.1"));
  ok("beta sees newer stable", isEligibleCandidate("5.1.0", "5.0.0-beta.1"));
  ok(
    "beta does not see different-base prerelease",
    !isEligibleCandidate("5.1.0-alpha.1", "5.0.0-beta.1"),
  );
  ok("beta does not see major prerelease", !isEligibleCandidate("6.0.0-alpha.1", "5.0.0-beta.1"));
  ok("beta does not see older beta", !isEligibleCandidate("5.0.0-alpha.1", "5.0.0-beta.1"));
}

const response = (data, options = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    ...options,
  });
const release = (tag, fields = {}) => ({
  tag_name: tag,
  html_url: officialLinks.releaseDetailUrl(tag),
  draft: false,
  prerelease: tag.includes("-"),
  body: "Release notes",
  ...fields,
});
const make = (fetchImpl, options = {}) =>
  updateCheck.createUpdateChecker({
    fetchImpl,
    version: "5.0.0",
    channel: "github",
    ...options,
  });
section("channel and release filtering");
let calls = 0;
const play = make(
  async () => {
    calls++;
    throw Error("must not fetch");
  },
  { channel: "play" },
);
equal("Play is delegated to the store", (await play.checkForUpdates()).status, "play");
equal("Play never contacts GitHub", calls, 0);
let request;
const available = make(async (url, options) => {
  request = { url, options };
  return response(release("v5.1.0", { body: "x".repeat(7000) }));
});
const update = await available.checkForUpdates();
equal("stable ignores future beta", update.latestVersion, "5.1.0");
equal("notes bounded", update.releaseNotes.length, 6000);
equal("redirects refused", request.options.redirect, "error");
equal("stable endpoint is fixed", request.url, updateCheck.GITHUB_LATEST_URL);
for (const [name, data] of [
  ["empty", []],
  ["older", [release("v4.9.0")]],
  ["draft", [release("v6.0.0", { draft: true })]],
  ["malformed", [release("not-semver")]],
  ["unofficial url", [release("v6.0.0", { html_url: "https://attacker.example/update" })]],
  ["channel mismatch", [release("v6.0.0", { prerelease: true })]],
  ["missing flags", [{ tag_name: "v6.0.0", html_url: officialLinks.releaseDetailUrl("v6.0.0") }]],
])
  equal(
    name,
    (
      await make(async () =>
        data.length ? response(data[0]) : response({}, { status: 404 }),
      ).checkForUpdates()
    ).status,
    "up_to_date",
  );
const beta = make(
  async (url) =>
    response(
      url === updateCheck.GITHUB_LATEST_URL ? release("v5.0.0") : [release("v5.0.0-beta.2")],
    ),
  {
    version: "5.0.0-beta.1",
  },
);
equal("beta can upgrade to stable", (await beta.checkForUpdates()).latestVersion, "5.0.0");
const manyPreviews = Array.from({ length: 10 }, (_, i) => release(`v6.0.0-beta.${i + 1}`));
const stableBehindPreviews = make(async (url) =>
  response(url === updateCheck.GITHUB_LATEST_URL ? release("v5.1.0") : manyPreviews),
);
equal(
  "stable behind ten newer previews is found",
  (await stableBehindPreviews.checkForUpdates()).latestVersion,
  "5.1.0",
);
const incompleteBeta = make(
  async (url) => response(url === updateCheck.GITHUB_LATEST_URL ? release("v4.9.0") : manyPreviews),
  { version: "5.0.0-beta.1" },
);
equal(
  "incomplete beta scan never says up to date",
  (await incompleteBeta.checkForUpdates()).status,
  "unavailable",
);

equal(
  "huge numeric component compares exactly",
  updateCheck.compareSemVer("9007199254740993.0.0", "9007199254740992.0.0"),
  1,
);
equal(
  "huge prerelease identifier compares exactly",
  updateCheck.compareSemVer("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"),
  1,
);
for (const bad of [" 1.0.0", "1.0.0 ", "V1.0.0", "1.0.0-beta.01", "1.0.0+", "1".repeat(200)]) {
  equal("strict version " + bad.slice(0, 25), updateCheck.parseSemVer(bad), null);
}
for (const bad of [
  "https://github.com:443/Abdodiab2005/levix/releases/tag/v5.0.0",
  " https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0",
  "https://github.com/Abdodiab2005/levix/releases/tag/v5.0.0%2Bbuild.1",
  "https://github.com/Abdodiab2005/levix/releases/tag/../tag/v5.0.0",
])
  equal("raw URL strict " + bad, officialLinks.safeOfficialUrl(bad), false);

section("offline, bad response, bounds and deadline");
for (const [name, fetchImpl] of [
  [
    "offline",
    async () => {
      throw Error("offline");
    },
  ],
  ["HTTP failure", async () => response({}, { status: 503 })],
  [
    "bad JSON",
    async () => new Response("not json", { headers: { "content-type": "application/json" } }),
  ],
  ["HTML", async () => new Response("<html>", { headers: { "content-type": "text/html" } })],
  ["bad shape", async () => response({})],
  ["redirected response", async () => ({ ok: true, url: "https://attacker.example" })],
  ["too many entries", async () => response(Array.from({ length: 11 }, () => release("v5.1.0")))],
  [
    "oversized streamed body",
    async () =>
      new Response("x".repeat(updateCheck.MAX_RESPONSE_BYTES + 1), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "oversized length",
    async () =>
      response([], {
        headers: {
          "content-type": "application/json",
          "content-length": String(updateCheck.MAX_RESPONSE_BYTES + 1),
        },
      }),
  ],
  ["hung headers", async () => new Promise(() => {})],
  [
    "hung body",
    async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      }),
  ],
]) {
  const result = await make(fetchImpl, { timeoutMs: 25 }).checkForUpdates();
  equal(name, result.status, "unavailable");
  equal(name + " preserves current version", result.currentVersion, "5.0.0");
  equal(name + " safe fallback", result.url, officialLinks.LINKS.releases);
}
let invalidCalls = 0;
equal(
  "bad current version unavailable",
  (
    await make(
      async () => {
        invalidCalls++;
        return response([]);
      },
      { version: "broken" },
    ).checkForUpdates()
  ).status,
  "unavailable",
);
equal("bad version performs no request", invalidCalls, 0);

section("cache and concurrent requests");
let clock = 1000,
  count = 0;
const cached = make(
  async () => {
    count++;
    await Promise.resolve();
    return response(release("v5.1.0"));
  },
  { now: () => clock },
);
await Promise.all([cached.checkForUpdates(), cached.checkForUpdates(), cached.checkForUpdates()]);
equal("concurrent requests coalesce", count, 1);
clock += updateCheck.SUCCESS_TTL_MS - 1;
await cached.checkForUpdates();
equal("cooldown uses cache", count, 1);
clock += 2;
await cached.checkForUpdates();
equal("expired cache refreshes", count, 2);
let failures = 0;
const offline = make(
  async () => {
    failures++;
    throw Error("offline");
  },
  { now: () => clock },
);
await offline.checkForUpdates();
await offline.checkForUpdates();
equal("failed checks cooled down", failures, 1);
clock += updateCheck.ERROR_TTL_MS + 1;
await offline.checkForUpdates();
equal("failed check retry", failures, 2);

section("update command uses one localized system reply");
const original = updateCheck.checkForUpdates;
const { withLang } = require("./src/utils/i18n.cjs");
try {
  for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
    for (const status of ["available", "up_to_date", "unavailable", "play"]) {
      updateCheck.checkForUpdates = async () => ({
        status,
        currentVersion: "5.0.0",
        latestVersion: "5.1.0",
        url: officialLinks.LINKS.releases,
      });
      const sent = [];
      await withLang(locale, () =>
        updateCommand.execute(
          { sendMessage: async (...args) => sent.push(args) },
          { key: { remoteJid: "1@g.us" } },
        ),
      );
      equal(locale + status + " one reply", sent.length, 1);
      equal(locale + status + " source chat", sent[0][0], "1@g.us");
      equal(locale + status + " system metadata", sent[0][2].levix.category, "system");
      ok(locale + status + " localized catalog", !sent[0][1].text.includes("bot.core.update."));
      ok(locale + status + " current version", sent[0][1].text.includes("5.0.0"));
    }
  }
} finally {
  updateCheck.checkForUpdates = original;
}
finish();
