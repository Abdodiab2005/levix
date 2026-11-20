// Static and pure-logic tests for the PR-5 Overview screen. No React import.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAttentionItems,
  buildQuickActions,
  isActiveProviderKeyConfigured,
  isReactionOutcomeFailure,
  selectOpenTodos,
  selectUpcomingSchedules,
} from "../frontend/src/views/overview/overviewData.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const overview = readFileSync(join(ROOT, "frontend/src/views/OverviewView.tsx"), "utf8");

section("OverviewView section order and design contract");
{
  const cardIdx = overview.indexOf("<ConnectedAccountCard");
  const statsIdx = overview.indexOf('data-tour="overview-stats"');
  const attentionIdx = overview.indexOf('t("overviewNeedsAttentionTitle")');
  const quickIdx = overview.indexOf('t("overviewQuickActionsTitle")');
  const upcomingIdx = overview.indexOf('t("overviewUpcomingTitle")');

  ok("1. compact account card is first", cardIdx > 0);
  ok("2. StatTile grid follows account card", statsIdx > cardIdx && overview.includes("<StatTile"));
  ok("3. Needs Attention follows StatTile grid", attentionIdx > statsIdx);
  ok("4. Quick Actions follows Needs Attention", quickIdx > attentionIdx);
  ok("5. Upcoming items follow Quick Actions", upcomingIdx > quickIdx);
  ok("old duplicate sidebar nav cards are removed", !overview.includes("quickNavCards"));
  ok("uses ListRow from ui barrel", overview.includes("<ListRow"));
}

section("Needs Attention: only real issues appear and healthy state is empty");
{
  const healthy = buildAttentionItems({
    status: { state: "connected", connected: true, linked: true },
    settings: [
      { key: "ai_provider", value: "gemini" },
      { key: "gemini_api_key", configured: true },
    ],
    plusStatus: {
      configured: true,
      entitlement: { state: "active", until: null, reason: null },
      extension: { state: "active" },
    },
    plusAvailable: true,
    schedules: [
      {
        id: "1",
        type: "once",
        targetJid: "201234567890@s.whatsapp.net",
        message: "hi",
        when: "Tomorrow",
        status: "active",
        lastDeliveryStatus: "success",
      },
    ],
    reactions: {
      automation: { enabled: true, revision: "r1" },
      rules: [
        {
          id: "rule1",
          revision: "1",
          chatJid: "201234567890@s.whatsapp.net",
          chatName: "Owner",
          priority: 100,
          enabled: true,
          enabledAt: 1,
          valid: true,
          statuses: ["READY"],
          overlaps: [],
          definition: {
            version: 1,
            emoji: "👍",
            transitions: ["add"],
            originalTypes: ["text"],
            senders: { role: "owner", ids: [] },
            action: "ping",
            destination: { mode: "same_chat" },
          },
          runtime: { lastCode: "DELIVERED", lastAt: 10, counts: {} },
        },
      ],
    },
  });
  equal("healthy state produces zero attention items", healthy.length, 0);

  // Linked but not connected + active AI provider without key + Plus expired (when offered)
  // + failed schedule + reaction switch off with enabled rule + failed reaction outcome
  const issues = buildAttentionItems({
    status: { state: "disconnected", connected: false, linked: true },
    settings: [
      { key: "ai_provider", value: "anthropic" },
      { key: "gemini_api_key", configured: true },
      { key: "anthropic_api_key", configured: false },
    ],
    plusStatus: {
      configured: true,
      entitlement: { state: "billing_retry", until: null, reason: null },
      extension: { state: "inactive" },
    },
    plusAvailable: true,
    schedules: [
      {
        id: "s1",
        type: "once",
        targetJid: "201234567890@s.whatsapp.net",
        message: "failed msg",
        when: "Today",
        status: "active",
        lastDeliveryStatus: "failed",
      },
    ],
    reactions: {
      automation: { enabled: false, revision: "r1" },
      rules: [
        {
          id: "rule1",
          revision: "1",
          chatJid: "201234567890@s.whatsapp.net",
          chatName: "Owner",
          priority: 100,
          enabled: true,
          enabledAt: 1,
          valid: true,
          statuses: ["AUTOMATION_OFF"],
          overlaps: [],
          definition: {
            version: 1,
            emoji: "👍",
            transitions: ["add"],
            originalTypes: ["text"],
            senders: { role: "owner", ids: [] },
            action: "ping",
            destination: { mode: "same_chat" },
          },
          runtime: { lastCode: "ACTION_FAILED", lastAt: 10, counts: {} },
        },
      ],
    },
  });

  equal(
    "all six attention conditions detected",
    issues.map((item) => item.id).join(","),
    "session,ai_key,plus,schedule_failed,reactions_switch_off,reactions_failed",
  );

  // Plus not offered on this platform -> no Plus attention item even if entitlement is expired
  const noPlusPlatform = buildAttentionItems({
    status: { state: "connected", connected: true, linked: true },
    plusStatus: {
      configured: false,
      entitlement: { state: "expired", until: null, reason: null },
      extension: { state: "absent" },
    },
    plusAvailable: false,
  });
  equal("Plus attention hidden where Plus is not offered", noPlusPlatform.length, 0);

  equal(
    "DELIVERED and NO_MATCH are not reaction failures",
    isReactionOutcomeFailure("DELIVERED") || isReactionOutcomeFailure("NO_MATCH"),
    false,
  );
  equal("ACTION_FAILED is a reaction failure", isReactionOutcomeFailure("ACTION_FAILED"), true);
  equal(
    "active provider key check follows ai_provider",
    isActiveProviderKeyConfigured([
      { key: "ai_provider", value: "openai" },
      { key: "gemini_api_key", configured: true },
      { key: "openai_api_key", configured: false },
    ]),
    false,
  );
}

section("Quick Actions adapt to connection state and target operational routes");
{
  const offlineActions = buildQuickActions({ state: "idle", linked: false });
  equal("offline first quick action is connect", offlineActions[0].id, "connect");
  equal("offline unlinked uses pair label", offlineActions[0].labelKey, "overviewQuickPairSession");

  const linkedStoppedActions = buildQuickActions({ state: "disconnected", linked: true });
  equal(
    "offline linked uses start label",
    linkedStoppedActions[0].labelKey,
    "overviewQuickStartSession",
  );

  const connectedActions = buildQuickActions({ state: "connected", connected: true, linked: true });
  equal(
    "connected quick actions cover reaction, schedule, ai and backup",
    connectedActions.map((a) => a.id).join(","),
    "reaction,schedule,ai,backup",
  );
  equal(
    "backup quick action targets #settings/backup",
    connectedActions[3].hash,
    "#settings/backup",
  );
}

section("Upcoming schedules and open todos cap at 3 and 5 and omit raw JIDs");
{
  const schedules = [
    {
      id: "paused-1",
      type: "once",
      targetJid: "201234567890@s.whatsapp.net",
      message: "Paused",
      when: "Soon",
      status: "paused",
      scheduledTime: 100,
    },
    {
      id: "s-later",
      type: "once",
      targetJid: "201234567890@s.whatsapp.net",
      message: "Later",
      when: "Later",
      status: "active",
      scheduledTime: 300,
    },
    {
      id: "s-sooner",
      type: "once",
      targetJid: "201234567890@s.whatsapp.net",
      message: "Sooner",
      when: "Sooner",
      status: "active",
      scheduledTime: 200,
    },
    {
      id: "s-rec-1",
      type: "recurring",
      targetJid: "201234567890@s.whatsapp.net",
      message: "Daily 1",
      when: "Daily",
      status: "active",
      createdAt: 10,
    },
    {
      id: "s-rec-2",
      type: "recurring",
      targetJid: "201234567890@s.whatsapp.net",
      message: "Daily 2",
      when: "Daily",
      status: "active",
      createdAt: 20,
    },
  ];
  const nextThree = selectUpcomingSchedules(schedules, 3);
  equal(
    "selects top 3 active schedules ordered by next time",
    nextThree.map((s) => s.id).join(","),
    "s-sooner,s-later,s-rec-1",
  );

  const todos = selectOpenTodos(
    [
      {
        user_id: "201234567890@s.whatsapp.net",
        tasks: ["Task 1", "Task 2", { text: "Done task", done: true }, "Task 3"],
      },
      {
        user_id: "987654321098765@lid",
        tasks: ["Task 4", "Task 5", "Task 6"],
      },
    ],
    5,
  );
  equal("caps open todos at 5 and skips completed items", todos.length, 5);
  equal(
    "open todo texts match",
    todos.map((item) => item.text).join(","),
    "Task 1,Task 2,Task 3,Task 4,Task 5",
  );
  ok(
    "selected todos do not expose user_id JIDs",
    todos.every((item) => !("user_id" in item) && !item.text.includes("@")),
  );
}

finish();
