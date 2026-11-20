// Home account card state mapping, profile retention across reconnects, and the
// static markup that consumes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canDisplaySavedProfile,
  mapSessionToCard,
  normalizeAccountId,
  shouldClearSavedProfile,
} from "../frontend/src/utils/accountCardState.ts";
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

section(
  "reconnect race: last good profile is retained while reconnecting for the same account and cleared on unlink or account change",
);
{
  equal(
    "device suffix stripped from PN",
    normalizeAccountId("201234567890:14@s.whatsapp.net"),
    "201234567890@s.whatsapp.net",
  );
  equal(
    "device suffix stripped from LID",
    normalizeAccountId("987654321098765:2@lid"),
    "987654321098765@lid",
  );
  equal("invalid JID normalizes to null", normalizeAccountId("not-a-jid"), null);

  const saved = {
    accountId: "201234567890@s.whatsapp.net",
    phone: "+201234567890",
    profile: { name: "Levix Owner" },
  };

  equal(
    "retained while reconnecting for the same linked account",
    canDisplaySavedProfile({ state: "reconnecting", linked: true, canUnlink: true }, saved),
    true,
  );
  equal(
    "retained while starting for the same linked account",
    canDisplaySavedProfile({ state: "starting", linked: true, canUnlink: true }, saved),
    true,
  );
  equal(
    "retained while connected with device-suffixed same user id",
    canDisplaySavedProfile(
      {
        state: "connected",
        connected: true,
        linked: true,
        canUnlink: true,
        user: { id: "201234567890:9@s.whatsapp.net" },
      },
      saved,
    ),
    true,
  );
  equal(
    "cleared immediately on logged_out",
    shouldClearSavedProfile({ state: "logged_out", linked: false }, saved),
    true,
  );
  equal(
    "cleared immediately on waiting_for_qr",
    shouldClearSavedProfile({ state: "waiting_for_qr", linked: false }, saved),
    true,
  );
  equal(
    "cleared immediately on unlink_incomplete",
    shouldClearSavedProfile({ state: "error", reason: "unlink_incomplete" }, saved),
    true,
  );
  equal(
    "cleared immediately when a different account connects",
    shouldClearSavedProfile(
      {
        state: "connected",
        connected: true,
        linked: true,
        canUnlink: true,
        user: { id: "201999999999@s.whatsapp.net" },
      },
      saved,
    ),
    true,
  );
}

section("the account card masks the phone by default with CodeText and uses showNumber/hideNumber");
{
  ok("card maps through accountCardState", accountCard.includes("mapSessionToCard"));
  ok("card masks the phone by default", accountCard.includes("••• ••• ••••"));
  ok("card uses CodeText for phone numbers", accountCard.includes("<CodeText"));
  ok("card uses UserText for names", accountCard.includes("<UserText"));
  ok("card uses showNumber", accountCard.includes('t("showNumber")'));
  ok("card uses hideNumber", accountCard.includes('t("hideNumber")'));
  ok(
    "card uses Eye and EyeOff icons",
    accountCard.includes("Eye") && accountCard.includes("EyeOff"),
  );
  ok("phone renders LTR-isolated", /CodeText|as="bdi" dir="ltr"|<bdi dir="ltr"/.test(accountCard));
  ok(
    "revealed state keyed by status.user.id",
    accountCard.includes("revealedAccount === status.user.id"),
  );
  ok("card renders the compact variant", /variant === "compact"/.test(accountCard));
  ok(
    "one status indicator shared by both variants",
    accountCard.split("<StatusPill").length - 1 === 1,
  );
}

section(
  "OverviewView calls api.startSession only behind the startable+linked condition and never calls api.stopSession",
);
{
  ok("OverviewView imports ConnectedAccountCard", /from "\.\/ConnectedAccountCard"/.test(overview));
  const use = overview.match(/<ConnectedAccountCard[\s\S]{0,350}?\/>/)?.[0] || "";
  ok("OverviewView renders exactly one account card", use !== "", use);
  ok('account card uses variant="compact"', /variant="compact"/.test(use));
  ok('account card navigates to "connection"', /onNavigate\("connection"\)/.test(use));
  ok("OverviewView calls api.startSession", overview.includes("api.startSession"));
  ok("OverviewView never calls api.stopSession", !overview.includes("api.stopSession"));
  for (const call of ["api.reconnectSession", "api.unlinkSession"]) {
    ok(`OverviewView does not call ${call}`, !overview.includes(call));
  }
  ok(
    "OverviewView checks startable states",
    /idle/.test(overview) &&
      /disconnected/.test(overview) &&
      /retry_exhausted/.test(overview) &&
      /error/.test(overview),
  );
  ok("OverviewView checks linked status", /status\?\.user\?\.id|status\?\.linked/.test(overview));
  ok(
    "OverviewView guards onStart behind startable and linked",
    /onStart=\{canQuickStart \? handleStart : undefined\}/.test(overview),
  );
  ok("OverviewView has no show/hide number toggle", !overview.includes("showNumber"));
}

section("Connection screen uses safe connection actions without a danger-zone card");
{
  ok("old header pill is gone", !connection.includes("pulse-dot"));
  ok("state is not printed through a raw key", !connection.includes("t(state as any"));
  ok("danger zone card is removed", !connection.includes('t("connectionDangerZone")'));
  ok(
    "stop uses an IconButton with connectionStopSession / connectionCancelAttempt label",
    connection.includes('t("connectionStopSession")') &&
      connection.includes('t("connectionCancelAttempt")'),
  );
  ok("stop still calls the session", connection.includes("api.stopSession"));
  ok("unlink still calls the session", connection.includes("api.unlinkSession"));
  ok(
    "unlink is a danger item inside OverflowMenu",
    connection.includes("OverflowMenu") &&
      connection.includes("<MenuItem") &&
      connection.includes("danger"),
  );
  ok(
    "unlink still confirms",
    connection.includes("showUnlinkModal") && connection.includes("connectionUnlinkConfirm"),
  );
  ok("reconnect still available", connection.includes("api.reconnectSession"));
  ok("restart still available", connection.includes("api.restartBot"));
  ok(
    "proxy Reconnect to apply is offered when proxyChanged is true",
    connection.includes("status?.proxyChanged") &&
      connection.includes('t("connectionProxyReconnect")'),
  );
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
  keys.add("connectionStopSession");
  keys.add("connectionProxyChangedTitle");
  keys.add("connectionProxyChangedBody");
  keys.add("connectionProxyReconnect");
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
