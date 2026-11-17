// Home account card state mapping and the static markup that consumes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapSessionToCard } from "../frontend/src/utils/accountCardState.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const view = (name) => readFileSync(join(ROOT, "frontend/src/views", name), "utf8");
const overview = view("OverviewView.tsx");
const accountCard = view("ConnectedAccountCard.tsx");
const connection = view("ConnectionView.tsx");

const states = [
  ["idle", "neutral", "accountCardNotConnected", "connect"],
  ["starting", "neutral", "accountCardConnecting", "manage"],
  ["linking", "neutral", "accountCardConnecting", "manage"],
  ["waiting_for_qr", "warn", "accountCardWaitingQr", "manage"],
  ["connected", "ok", "connected", "manage"],
  ["reconnecting", "warn", "accountCardReconnecting", "reconnect"],
  ["disconnected", "neutral", "accountCardNotConnected", "connect"],
  ["paused", "neutral", "accountCardPaused", "connect"],
  ["retry_exhausted", "danger", "accountCardRetryExhausted", "connect"],
  ["logged_out", "danger", "accountCardLoggedOut", "connect"],
  ["consent_required", "warn", "accountCardConsentRequired", "connect"],
  ["error", "danger", "accountCardError", "connect"],
];

section("every session state maps to one status line and one action");
for (const [state, tone, labelKey, action] of states) {
  const card = mapSessionToCard({ state });
  equal(`${state} tone`, card.tone, tone);
  equal(`${state} label key`, card.labelKey, labelKey);
  equal(`${state} action`, card.action, action);
  equal(`${state} is not a loading card`, card.loading, false);
}

section("showProfile is true only while connected");
for (const [state] of states) {
  if (state === "connected") continue;
  equal(`${state} hides the profile`, mapSessionToCard({ state }).showProfile, false);
}
equal(
  "connected shows the profile",
  mapSessionToCard({ state: "connected", connected: true }).showProfile,
  true,
);

section("a missing snapshot is a loading card");
{
  const card = mapSessionToCard(null);
  equal("null is loading", card.loading, true);
  equal("null shows no profile", card.showProfile, false);
  equal("null tone", card.tone, "neutral");
  equal("null has a label key", typeof card.labelKey === "string", true);
  equal("null itself is not a connected state", card.labelKey === "connected", false);
}

section("retry attempt reaches the card only when the session reports one");
{
  const withAttempt = mapSessionToCard({ state: "reconnecting", attempt: 2, maxAttempts: 5 });
  equal("attempt forwarded", withAttempt.attempt, 2);
  equal("max forwarded", withAttempt.maxAttempts, 5);
  const without = mapSessionToCard({ state: "reconnecting" });
  equal("no attempt is null", without.attempt, null);
  equal("no max is null", without.maxAttempts, null);
  const junk = mapSessionToCard({ state: "reconnecting", attempt: 0, maxAttempts: -3 });
  equal("non-positive attempt is dropped", junk.attempt, null);
  equal("non-positive max is dropped", junk.maxAttempts, null);
}

section("Home renders the compact card and never runs session actions");
{
  ok("OverviewView imports ConnectedAccountCard", /from "\.\/ConnectedAccountCard"/.test(overview));
  const use = overview.match(/<ConnectedAccountCard[\s\S]{0,240}?\/>/)?.[0] || "";
  ok("OverviewView renders exactly one account card", use !== "", use);
  ok('account card uses variant="compact"', /variant="compact"/.test(use));
  ok('account card navigates to "connection"', /onNavigate\("connection"\)/.test(use));
  for (const call of [
    "api.startSession",
    "api.stopSession",
    "api.reconnectSession",
    "api.unlinkSession",
  ]) {
    ok(`OverviewView does not call ${call}`, !overview.includes(call));
  }
  ok("OverviewView has no show/hide number toggle", !overview.includes("showNumber"));
}

section("compact card keeps the phone readable and unmasked");
{
  ok("card maps through accountCardState", accountCard.includes("mapSessionToCard"));
  ok(
    "phone renders LTR-isolated",
    /<UserText as="bdi" dir="ltr"[\s\S]{0,80}\{visible\.phone\}/.test(accountCard),
  );
  ok("compact card does not mask the phone", !accountCard.includes("•••"));
  ok("card renders the compact variant", /variant === "compact"/.test(accountCard));
  ok(
    "one status indicator shared by both variants",
    accountCard.split("<StatusPill").length - 1 === 1,
  );
}

section("Connection screen keeps one status display and a danger zone");
{
  ok("old header pill is gone", !connection.includes("pulse-dot"));
  ok("state is not printed through a raw key", !connection.includes("t(state as any"));
  ok("danger zone exists", connection.includes('t("connectionDangerZone")'));
  ok(
    "stop uses the danger tone label",
    connection.includes('t("connectionStopSession")') &&
      connection.includes('t("connectionCancelAttempt")'),
  );
  ok("stop still calls the session", connection.includes("api.stopSession"));
  ok("unlink still calls the session", connection.includes("api.unlinkSession"));
  ok("unlink still confirms", connection.includes("showUnlinkModal") && connection.includes("connectionUnlinkConfirm"));
  ok("reconnect still available", connection.includes("api.reconnectSession"));
  ok("restart still available", connection.includes("api.restartBot"));
  ok("no overflow menu plumbing left", !connection.includes("OverflowMenu"));
}

section("no physical-direction layout, hex colours or one-off palettes");
{
  const layout = /\b(?:ml|mr|pl|pr|left|right)-|\btext-(?:left|right)\b/;
  const hex = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
  const palette =
    /\b(?:text|bg|border)-(?:red|slate|gray|zinc|neutral|stone|blue|green|yellow|amber|orange|pink|purple|indigo|rose|teal|cyan|sky|violet|fuchsia|lime|emerald)-\d{2,3}\b/;
  for (const [name, text] of [
    ["OverviewView.tsx", overview],
    ["ConnectedAccountCard.tsx", accountCard],
    ["ConnectionView.tsx", connection],
  ]) {
    ok(`${name} has no physical layout classes`, !layout.test(text));
    ok(`${name} has no raw hex colours`, !hex.test(text));
    ok(`${name} has no one-off palette`, !palette.test(text));
  }
}

section("every status label is translated in all four locales");
{
  const catalogs = Object.fromEntries(
    ["en", "ar", "pt-BR", "es-419"].map((locale) => [
      locale,
      JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8")),
    ]),
  );
  const keys = new Set();
  for (const [state] of states) keys.add(mapSessionToCard({ state }).labelKey);
  keys.add(mapSessionToCard(null).labelKey);
  keys.add("accountCardAttempt");
  keys.add("accountCardManageSession");
  keys.add("accountCardProfileUnavailable");
  keys.add("connectionDangerZone");
  keys.add("connectionDangerZoneDesc");
  keys.add("connectionStopSession");
  for (const key of [...keys].sort()) {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      ok(
        `${locale} has ${key}`,
        typeof catalog[key] === "string" && catalog[key].trim().length > 0,
      );
    }
  }
}

finish();
