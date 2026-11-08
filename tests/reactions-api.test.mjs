import {
  equal,
  finish,
  httpClient,
  ok,
  require,
  section,
  startServer,
  throws,
  useTempDataDir,
} from "./harness.mjs";

const dataDir = useTempDataDir("levix-reactions-api");
const prefix = "/dashboard/api/reactions";
const chat = "120363700000001@g.us";
const bot = "201070000099@s.whatsapp.net";
const author = "201070000001@s.whatsapp.net";
const reactor = "201070000002@s.whatsapp.net";
function definition(patch = {}) {
  return {
    version: 1,
    emoji: "😀",
    transitions: ["add", "change", "remove"],
    originalTypes: ["text"],
    senders: { role: "any", ids: [] },
    action: "ping",
    destination: { mode: "same_chat" },
    ...patch,
  };
}
const draft = (patch = {}) => ({ chatJid: chat, priority: 0, definition: definition(), ...patch });
const endpoints = [
  ["GET", ""],
  ["POST", "/rules/check"],
  ["POST", "/rules"],
  ["PUT", "/rules/missing"],
  ["POST", "/rules/missing/enabled"],
  ["DELETE", "/rules/missing?revision=old"],
  ["PUT", "/automation"],
];
const server = await startServer({ dataDir, routes: true });
const http = httpClient(server.base);
async function json(path, body, method = "POST") {
  const response = await http.json(prefix + path, body, method);
  return { status: response.status, body: await response.json() };
}
async function invalid(label, path, body, method = "POST", field, code = "invalid") {
  const result = await json(path, body, method);
  equal(`${label}: HTTP 400`, result.status, 400);
  equal(`${label}: fixed error`, result.body.error, "REACTION_RULE_INVALID");
  equal(`${label}: failure`, result.body.success, false);
  if (field)
    ok(
      `${label}: field issue`,
      result.body.issues?.some((issue) => issue.field === field && issue.code === code),
    );
}

try {
  section("authentication on all seven routes");
  for (const [method, path] of endpoints) {
    const response = await http.call(prefix + path, {
      method,
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft()),
          }),
    });
    equal(`${method} ${path}: no session`, response.status, 401);
  }
  const setup = await http.form(
    "/setup",
    {
      password: "a-good-password",
      confirm: "a-good-password",
    },
    { origin: server.base },
  );
  equal("setup signs in", setup.status, 303);

  section("origin guard on every mutation");
  for (const origin of ["null", "https://foreign.example.invalid"]) {
    for (const [method, path] of endpoints.filter(([method]) => method !== "GET")) {
      const response = await http.call(prefix + path, {
        method,
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(draft()),
      });
      equal(`${method} ${path}: Origin ${origin}`, response.status, 403);
    }
  }

  section("draft checks, field errors and strict body shapes");
  let response = await http.call(prefix);
  let overview = await response.json();
  equal("initial overview succeeds", response.status, 200);
  equal("automation starts off", overview.automation.enabled, false);
  equal("no session is disconnected", overview.connection.connected, false);
  equal("unpaired owner is not linked", overview.owner.linked, false);
  equal("initial rules empty", overview.rules.length, 0);
  let result = await json("/rules/check", draft());
  equal("valid draft check succeeds", result.status, 200);
  equal("valid draft issues empty", result.body.issues.length, 0);
  result = await json(
    "/rules/check",
    draft({ priority: -1, definition: definition({ action: "shell" }) }),
  );
  equal("invalid draft check is read-only feedback", result.status, 200);
  ok(
    "draft identifies priority",
    result.body.issues.some((issue) => issue.field === "priority"),
  );
  ok(
    "draft identifies action",
    result.body.issues.some((issue) => issue.field === "definition.action"),
  );
  response = await http.call(prefix);
  equal("draft checks write no rules", (await response.json()).rules.length, 0);

  await invalid(
    "missing definition",
    "/rules",
    { chatJid: chat, priority: 0 },
    "POST",
    "definition",
  );
  for (const chatJid of ["", "123", "1:7@lid", "status@broadcast", "1@newsletter"])
    await invalid(`chat ${chatJid}`, "/rules", draft({ chatJid }), "POST", "chatJid");
  for (const priority of [-1, 1001, 1.5, "0", null])
    await invalid(`priority ${priority}`, "/rules", draft({ priority }), "POST", "priority");
  await invalid("non-object body", "/rules", []);
  for (const key of ["id", "enabled", "enabledAt", "revision", "code", "__proto__", "constructor"])
    await invalid(
      `smuggled ${key}`,
      "/rules",
      { ...draft(), [key]: true },
      "POST",
      "body",
      "unknown_field",
    );
  await invalid(
    "definition arguments",
    "/rules",
    draft({
      definition: definition({ arguments: "!kick @all" }),
    }),
    "POST",
    "definition.arguments",
    "unknown_field",
  );
  await invalid(
    "destination JID",
    "/rules",
    draft({
      definition: definition({ destination: { mode: "same_chat", jid: chat } }),
    }),
    "POST",
    "definition.destination.jid",
    "unknown_field",
  );
  await invalid(
    "STT requires voice only",
    "/rules",
    draft({
      definition: definition({ action: "stt" }),
    }),
    "POST",
    "definition.originalTypes",
    "voice_only",
  );

  section("create, revisions, edits, switches and deletion");
  result = await json("/rules", draft());
  equal("create uses 201", result.status, 201);
  equal("create succeeds", result.body.success, true);
  let rule = result.body.rule;
  equal("created rule starts disabled", rule.enabled, false);
  equal("created rule has no enablement epoch", rule.enabledAt, null);
  ok("created rule has revision", typeof rule.revision === "string" && rule.revision.length > 0);
  ok("created rule reports off", rule.statuses.includes("RULE_OFF"));
  const createdRevision = rule.revision;
  const id = rule.id;
  result = await json(`/rules/${id}/enabled`, { revision: rule.revision, enabled: true });
  equal("enable succeeds", result.status, 200);
  rule = result.body.rule;
  equal("rule is enabled", rule.enabled, true);
  ok("enable sets epoch", Number.isSafeInteger(rule.enabledAt));
  ok("enable rotates revision", rule.revision !== createdRevision);
  result = await json(`/rules/${id}`, { ...draft(), revision: createdRevision }, "PUT");
  equal("stale edit conflicts", result.status, 409);
  equal("stale edit code", result.body.error, "REACTION_RULE_CHANGED");
  result = await json(`/rules/${id}/enabled`, { revision: createdRevision, enabled: false });
  equal("stale toggle conflicts", result.status, 409);
  response = await http.call(`${prefix}/rules/${id}?revision=${createdRevision}`, {
    method: "DELETE",
  });
  equal("stale delete conflicts", response.status, 409);
  equal("stale delete code", (await response.json()).error, "REACTION_RULE_CHANGED");
  const enabledRevision = rule.revision;
  await invalid(
    "edit cannot set enabled",
    `/rules/${id}`,
    {
      ...draft(),
      revision: rule.revision,
      enabled: true,
    },
    "PUT",
    "body",
    "unknown_field",
  );
  await invalid("edit requires revision", `/rules/${id}`, draft(), "PUT", "revision");
  result = await json(
    `/rules/${id}`,
    { ...draft({ priority: 20 }), revision: rule.revision },
    "PUT",
  );
  equal("edit succeeds", result.status, 200);
  rule = result.body.rule;
  equal("edit disables rule", rule.enabled, false);
  equal("edit clears epoch", rule.enabledAt, null);
  equal("edit saves priority", rule.priority, 20);
  ok("edit rotates revision", rule.revision !== enabledRevision);
  for (const enabled of [true, false]) {
    const prior = rule.revision;
    result = await json(`/rules/${id}/enabled`, { revision: prior, enabled });
    equal(`toggle ${enabled} succeeds`, result.status, 200);
    rule = result.body.rule;
    equal(`toggle ${enabled} saved`, rule.enabled, enabled);
    ok("toggle rotates revision", rule.revision !== prior);
  }
  await invalid(
    "toggle needs boolean",
    `/rules/${id}/enabled`,
    {
      revision: rule.revision,
      enabled: "true",
    },
    "POST",
    "enabled",
  );
  await invalid(
    "toggle rejects extras",
    `/rules/${id}/enabled`,
    {
      revision: rule.revision,
      enabled: true,
      definition: definition(),
    },
    "POST",
    "body",
    "unknown_field",
  );
  for (const enabled of [true, false]) {
    result = await json("/automation", { enabled }, "PUT");
    equal(`automation ${enabled} succeeds`, result.status, 200);
    equal(`automation ${enabled} saved`, result.body.automation.enabled, enabled);
  }
  await invalid("automation boolean", "/automation", { enabled: 1 }, "PUT", "enabled");
  await invalid(
    "automation extras",
    "/automation",
    { enabled: true, revision: "fake" },
    "PUT",
    "body",
    "unknown_field",
  );
  response = await http.call(`${prefix}/rules/${id}`, { method: "DELETE" });
  equal("delete requires revision", response.status, 400);
  response = await http.call(`${prefix}/rules/${id}?revision=${rule.revision}`, {
    method: "DELETE",
  });
  equal("delete succeeds", response.status, 200);
  equal("delete body", JSON.stringify(await response.json()), JSON.stringify({ success: true }));
  for (const [method, path, body] of [
    ["PUT", `/rules/${id}`, { ...draft(), revision: rule.revision }],
    ["POST", `/rules/${id}/enabled`, { revision: rule.revision, enabled: true }],
    ["DELETE", `/rules/${id}?revision=${rule.revision}`, undefined],
  ]) {
    response =
      method === "DELETE"
        ? await http.call(prefix + path, { method })
        : await http.json(prefix + path, body, method);
    equal(`${method} missing rule`, response.status, 404);
    equal("missing rule code", (await response.json()).error, "REACTION_RULE_MISSING");
  }

  section("150 rules have no tier cap and unpaired destinations explain refusal");
  for (let index = 0; index < 150; index++) {
    result = await json(
      "/rules",
      draft({
        priority: index % 3,
        definition: definition({
          destination: { mode: index === 0 ? "owner_private" : "same_chat" },
        }),
      }),
    );
    equal(`create rule ${index}`, result.status, 201);
    if (index === 0)
      ok(
        "unpaired owner destination status",
        result.body.rule.statuses.includes("OWNER_NOT_LINKED"),
      );
  }
  response = await http.call(prefix);
  overview = await response.json();
  equal("list all 150", overview.rules.length, 150);
  ok(
    "all are disabled",
    overview.rules.every((item) => !item.enabled),
  );
  const ids = overview.rules.map((item) => item.id);
  equal("list has distinct ids", new Set(ids).size, 150);
  const sorted = [...overview.rules].sort(
    (a, b) => a.priority - b.priority || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  );
  equal(
    "list uses priority then binary id",
    JSON.stringify(ids),
    JSON.stringify(sorted.map((item) => item.id)),
  );
  equal("overlaps capped", overview.rules.at(-1).overlaps.length, 20);
} finally {
  server.stop();
}

section("facade reads live session, linked identity, directory and readiness");
const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const groups = require("./src/utils/groupMetadataCache.cjs");
const manage = await import("../src/automation/manage.js");
const { createReactionAutomation, REACTION_ACTION_LIMITS } = await import(
  "../src/automation/engine.js"
);
db.exec("DELETE FROM reaction_rules");
store.saveBotSetting("disabled_commands", []);
store.saveBotSetting("command_permissions", {});
store.authRemove("creds");
let connected = false;
manage.setSession({ getState: () => ({ connected }) });
for (const body of [null, "rule", 1]) {
  const error = throws("facade rejects non-object body", () => manage.createRule(body));
  equal("non-object body uses typed 400", error?.status, 400);
}
let local = manage.createRule(draft());
equal("facade initially disconnected", manage.overview().connection.connected, false);
connected = true;
equal("facade follows same manager live", manage.overview().connection.connected, true);
equal("exported reactor budget", REACTION_ACTION_LIMITS.perReactor, 3);
equal("exported chat budget", REACTION_ACTION_LIMITS.perChat, 10);
equal("exported rule budget", REACTION_ACTION_LIMITS.perRule, 5);
equal("exported global jobs", REACTION_ACTION_LIMITS.globalJobs, 2);
equal("exported window", REACTION_ACTION_LIMITS.windowMs, 60_000);
groups.setCached(chat, { id: chat, subject: "Cached group", participants: [] });
equal("chat name uses RAM cache", manage.overview().rules[0].chatName, "Cached group");
groups.flushAll();
store.upsertGroupDirectory(chat, { subject: "Directory group", participantCount: 3 });
equal("chat name falls back to directory", manage.overview().rules[0].chatName, "Directory group");
store.setReactionAutomationEnabled(true);
local = manage.setRuleEnabled(local.id, { revision: local.revision, enabled: true });
equal("unpaired same-chat ping is ready", local.statuses.join(","), "READY");
runtime.setEnabled("ping", false);
ok("disabled command reported", manage.overview().rules[0].statuses.includes("ACTION_DISABLED"));
runtime.setEnabled("ping", true);
const voice = manage.createRule(
  draft({
    priority: 2,
    definition: definition({
      action: "stt",
      originalTypes: ["voice"],
      destination: { mode: "owner_private" },
    }),
  }),
);
settings.set("ai_stt_enabled", false);
settings.set("ai_stt_provider", "openai");
settings.set("openai_api_key", "");
let voiceView = manage.overview().rules.find((item) => item.id === voice.id);
for (const code of ["STT_DISABLED", "STT_KEY_MISSING", "OWNER_NOT_LINKED"])
  ok(`readiness ${code}`, voiceView.statuses.includes(code));
store.authWrite("creds", JSON.stringify({ me: { id: bot }, registered: true }));
settings.set("ai_stt_enabled", true);
settings.set("openai_api_key", "isolated-not-a-real-key");
voiceView = manage.setRuleEnabled(voice.id, { revision: voice.revision, enabled: true });
equal("configured owner STT ready", voiceView.statuses.join(","), "READY");
equal("owner linked from credentials", manage.overview().owner.linked, true);
const privateRule = manage.createRule(draft({ chatJid: author }));
store.saveUserMetadata({ jid: author, displayName: "Known contact" });
equal(
  "contact label uses describePeer",
  manage.overview().rules.find((item) => item.id === privateRule.id).chatName,
  store.describePeer(author).label,
);
db.prepare("UPDATE reaction_rules SET definition='not-json' WHERE id=?").run(privateRule.id);
const corrupt = manage.overview().rules.find((item) => item.id === privateRule.id);
equal("corrupt rule remains visible", corrupt.valid, false);
ok("corrupt rule explains invalidity", corrupt.statuses.includes("RULE_INVALID"));

section("candidate warning and binary overlap precedence");
for (const id of ["a", "A", "z"]) store.saveReactionRule({ id, ...draft({ priority: 5 }) });
let views = manage.overview().rules;
equal(
  "uppercase id sorts before lowercase",
  views.find((item) => item.id === "a").overlaps.includes("A"),
  true,
);
equal(
  "later lowercase id is not earlier",
  views.find((item) => item.id === "A").overlaps.includes("a"),
  false,
);
const nonoverlap = manage.createRule(draft({ definition: definition({ emoji: "👍" }) }));
ok(
  "different emoji never overlaps",
  manage
    .overview()
    .rules.find((item) => item.id === "z")
    .overlaps.every((id) => id !== nonoverlap.id),
);
for (let index = 0; index < 100; index++) {
  const rule = store.saveReactionRule({ id: `candidate-${index}`, ...draft() });
  store.setReactionRuleEnabled(rule.id, true);
  if (index === 98)
    ok(
      "100 candidates do not warn",
      !manage
        .overview()
        .rules.find((item) => item.id === local.id)
        .statuses.includes("CANDIDATE_LIMIT"),
    );
}
views = manage.overview().rules;
ok(
  "101 shared enabled candidates warn",
  views.find((item) => item.id === local.id).statuses.includes("CANDIDATE_LIMIT"),
);
ok(
  "warning is per trigger",
  !views.find((item) => item.id === nonoverlap.id).statuses.includes("CANDIDATE_LIMIT"),
);

section("candidate warnings count concrete event pairs, not their union");
db.exec("DELETE FROM reaction_rules");
function addEnabled(id, chatJid, priority, patch = {}, enabled = true) {
  const row = store.saveReactionRule({
    id,
    chatJid,
    priority,
    definition: definition(patch),
  });
  if (enabled) store.setReactionRuleEnabled(id, true);
  return row;
}
addEnabled("broad-target", chat, 5, { originalTypes: ["text", "voice"] });
for (const [transition, type] of [
  ["add", "text"], ["change", "voice"], ["remove", "text"],
]) {
  for (let index = 0; index < 60; index++) {
    addEnabled(`${transition}-${index}`, chat, 10, {
      transitions: [transition],
      originalTypes: [type],
    });
  }
}
let eventViews = manage.overview().rules;
ok(
  "181 overlapping enabled rules do not exceed any event's limit",
  !eventViews.find((item) => item.id === "broad-target").statuses.includes("CANDIDATE_LIMIT"),
);
equal(
  "engine prefilter sees only 61 add/text candidates",
  store.reactionRulesForChats([chat], { emoji: "😀", type: "add", originalType: "text" }).length,
  61,
);
for (let index = 0; index < 39; index++)
  addEnabled(`boundary-${index}`, chat, 10, { transitions: ["add"], originalTypes: ["text"] });
ok(
  "exactly 100 candidates for a concrete event do not warn",
  !manage
    .overview()
    .rules.find((item) => item.id === "broad-target")
    .statuses.includes("CANDIDATE_LIMIT"),
);
addEnabled("event-101", chat, 10, { transitions: ["add"], originalTypes: ["text"] });
eventViews = manage.overview().rules;
ok(
  "101 candidates for one concrete event warn",
  eventViews.find((item) => item.id === "broad-target").statuses.includes("CANDIDATE_LIMIT"),
);
ok(
  "a disjoint transition/type pair does not warn",
  !eventViews.find((item) => item.id === "change-0").statuses.includes("CANDIDATE_LIMIT"),
);
addEnabled("multi-pair-overlap", chat, 1, { originalTypes: ["text", "voice"] }, false);
const pairOverlap = manage.overview().rules.find((item) => item.id === "broad-target").overlaps;
equal("shared multiple pairs contribute one overlap id", pairOverlap.join(","), "multi-pair-overlap");

section("candidate warnings and overlaps share PN/LID alias scope");
db.exec("DELETE FROM reaction_rules");
const pnChat = "201070000123@s.whatsapp.net";
const lidChat = "700000123@lid";
store.storeLidPnMapping(lidChat, pnChat);
const onePair = { transitions: ["add"], originalTypes: ["text"] };
addEnabled("pn-target", pnChat, 5, onePair);
for (let index = 0; index < 50; index++) {
  addEnabled(index === 0 ? "Z-pn" : `pn-${index}`, pnChat, index === 0 ? 1 : 10, onePair);
  addEnabled(index === 0 ? "A-lid" : `lid-${index}`, lidChat, index === 0 ? 1 : 10, onePair);
}
let aliasViews = manage.overview().rules;
for (const id of ["pn-target", "A-lid"]) {
  ok(
    `${id}: 101 candidates across aliases warn`,
    aliasViews.find((item) => item.id === id).statuses.includes("CANDIDATE_LIMIT"),
  );
}
equal(
  "engine prefilter counts the same alias candidates",
  store.reactionRulesForChats(store.reactionIdentityAliases(pnChat), {
    emoji: "😀",
    type: "add",
    originalType: "text",
  }).length,
  101,
);
equal(
  "overlaps sort priority and binary id across aliases",
  aliasViews.find((item) => item.id === "pn-target").overlaps.join(","),
  "A-lid,Z-pn",
);
equal(
  "overlaps across aliases are capped at 20",
  aliasViews.find((item) => item.id === "pn-49").overlaps.length,
  20,
);
store.setReactionRuleEnabled("lid-49", false);
for (let index = 0; index < 5; index++) {
  addEnabled(`disabled-${index}`, pnChat, 10, onePair, false);
  addEnabled(`wrong-emoji-${index}`, pnChat, 10, { ...onePair, emoji: "👍" });
  addEnabled(`other-chat-${index}`, chat, 10, onePair);
}
aliasViews = manage.overview().rules;
ok(
  "disabled, other emoji and unrelated chat rules do not push an event above 100",
  !aliasViews.find((item) => item.id === "pn-target").statuses.includes("CANDIDATE_LIMIT"),
);

section("overview builds each alias index once and avoids cross-chat pairwise scans");
const savedAliasLookup = store.reactionIdentityAliases;
const savedRuleList = store.listReactionRules;
let aliasCalls = 0;
let enabledReads = 0;
try {
  const aliasRows = savedRuleList().filter((row) => [pnChat, lidChat].includes(row.chat_jid));
  store.listReactionRules = () =>
    aliasRows.map((row) => ({
      ...row,
      get enabled() {
        enabledReads++;
        return row.enabled;
      },
    }));
  store.reactionIdentityAliases = (jid) => {
    aliasCalls++;
    return savedAliasLookup(jid);
  };
  manage.overview();
  equal("alias lookup cached per distinct chat", aliasCalls, 2);
  ok("equivalent aliases build enabled counts once", enabledReads <= aliasRows.length * 3);
} finally {
  store.listReactionRules = savedRuleList;
  store.reactionIdentityAliases = savedAliasLookup;
}
db.exec("DELETE FROM reaction_rules");
for (let chatIndex = 0; chatIndex < 50; chatIndex++) {
  const jid = `${120363800000000 + chatIndex}@g.us`;
  for (let index = 0; index < 3; index++)
    addEnabled(`isolated-${chatIndex}-${index}`, jid, index, onePair);
}
let chatReads = 0;
aliasCalls = 0;
try {
  const rows = savedRuleList();
  store.listReactionRules = () =>
    rows.map((row) => ({
      ...row,
      get chat_jid() {
        chatReads++;
        return row.chat_jid;
      },
    }));
  store.reactionIdentityAliases = (jid) => {
    aliasCalls++;
    return savedAliasLookup(jid);
  };
  const isolatedViews = manage.overview().rules;
  equal("each chat's aliases resolved once per overview", aliasCalls, 50);
  ok("chat reads stay linear in rule count", chatReads < rows.length * 30);
  ok(
    "overlaps stay within their chat group",
    isolatedViews.every((item) =>
      item.overlaps.every((id) => id.split("-")[1] === item.id.split("-")[1]),
    ),
  );
} finally {
  store.listReactionRules = savedRuleList;
  store.reactionIdentityAliases = savedAliasLookup;
}

section("every facade write notifies a running engine and cancels pending work");
db.exec(
  "DELETE FROM reaction_rules; DELETE FROM reaction_events; DELETE FROM reaction_state; DELETE FROM reaction_budgets;",
);
let clock = Date.now() + 10_000;
let sequence = 0;
let release;
let entered;
const sock = {
  user: { id: bot },
  groupMetadata() {
    entered = true;
    return new Promise((resolve) => {
      release = resolve;
    });
  },
  sendMessage() {
    throw new Error("cancelled job must not send");
  },
};
const changes = [];
const unsubscribe = store.subscribeReactionChanges((change) => changes.push(change));
const engine = createReactionAutomation(sock, { now: () => clock });
engine.intake.open();
try {
  for (const operation of [
    "create",
    "update",
    "enable",
    "disable",
    "delete",
    "automation-on",
    "automation-off",
  ]) {
    let rule = manage.createRule(draft());
    store.setReactionRuleEnabled(rule.id, true, clock);
    manage.setAutomation({ enabled: true });
    rule = store.getReactionRule(rule.id);
    clock += 2000;
    const original = {
      key: { remoteJid: chat, participant: author, id: `original-${++sequence}`, fromMe: false },
      message: { conversation: "private input never enters management" },
      messageTimestamp: Math.floor(clock / 1000),
    };
    engine.intake.observeUpsert({ type: "notify", messages: [original] });
    equal(`${operation}: lookup retained`, engine.intake.stats().items, 1);
    entered = false;
    engine.intake.observeReactions([
      {
        key: original.key,
        reaction: {
          key: { remoteJid: chat, participant: reactor, id: `event-${++sequence}`, fromMe: false },
          text: "😀",
          senderTimestampMs: ++clock,
        },
      },
    ]);
    equal(`${operation}: job entered fake metadata`, entered, true);
    equal(`${operation}: running job`, engine.stats().active, 1);
    const before = changes.length;
    if (operation === "create") manage.createRule(draft({ priority: 1 }));
    if (operation === "update") manage.updateRule(rule.id, { ...draft(), revision: rule.revision });
    if (operation === "enable")
      manage.setRuleEnabled(rule.id, { revision: rule.revision, enabled: true });
    if (operation === "disable")
      manage.setRuleEnabled(rule.id, { revision: rule.revision, enabled: false });
    if (operation === "delete") manage.deleteRule(rule.id, rule.revision);
    if (operation === "automation-on") manage.setAutomation({ enabled: true });
    if (operation === "automation-off") manage.setAutomation({ enabled: false });
    ok(`${operation}: store notification`, changes.length > before);
    equal(`${operation}: lookup reset immediately`, engine.intake.stats().items, 0);
    release({ id: chat, participants: [{ id: bot }, { id: author }, { id: reactor }] });
    await engine.settled();
    equal(`${operation}: action cancelled`, engine.stats().lastCode, "REACTION_CANCELLED");
    db.exec("DELETE FROM reaction_rules; DELETE FROM reaction_budgets;");
  }
} finally {
  unsubscribe();
  engine.close();
  manage.setSession(null);
}

section("typed errors and internal error response");
const error = throws("facade rejects invalid create", () =>
  manage.createRule(draft({ priority: -1 })),
);
ok("facade error type", error instanceof manage.ReactionManageError);
equal("facade status", error?.status, 400);
const router = (await import("../src/routes/reactions.api.esm.js")).default;
const logger = require("./src/utils/logger.cjs");
const savedList = store.listReactionRules;
const savedError = logger.error;
let logged;
let payload;
let statusCode;
try {
  store.listReactionRules = () => {
    throw new Error("isolated storage failure");
  };
  logger.error = (...args) => {
    logged = args;
  };
  const handler = router.stack.find((layer) => layer.route?.path === "/reactions").route.stack[0]
    .handle;
  handler(
    { body: { secret: "must-not-be-logged" } },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        payload = body;
      },
    },
  );
  equal("unexpected failure uses 500", statusCode, 500);
  equal("unexpected failure uses INTERNAL", payload?.error, "INTERNAL");
  equal("unexpected failure is unsuccessful", payload?.success, false);
  ok(
    "unexpected failure logged without body",
    logged && !JSON.stringify(logged).includes("must-not-be-logged"),
  );
} finally {
  store.listReactionRules = savedList;
  logger.error = savedError;
}
finish();
