// file: frontend/src/views/GroupsView.tsx

import { Eraser, RotateCcw, ShieldAlert, UserX, Users } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Disclosure,
  EmptyState,
  Field,
  FilterButton,
  FormActions,
  IconButton,
  Input,
  MenuItem,
  OverflowMenu,
  PageHeader,
  Pagination,
  RadioGroup,
  RelativeTime,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  SortMenu,
  Textarea,
  Toggle,
  Toolbar,
  UserText,
  useDirtyForm,
  usePagination,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type {
  CommandItem,
  FlaggedMember,
  GroupItem,
  ModerationPolicy,
  ModerationPolicyFieldError,
  ModerationPolicyVisibility,
} from "../types";
import { fill } from "../utils/fill";
import { useCommandLabels } from "./commands/shared";

type Tri = "any" | "on" | "off";
type MediaFilter = "any" | "none" | "block_all" | "custom";

/** Every schema default; a group with no policy behaves exactly like this. */
const DEFAULT_POLICY: ModerationPolicy = {
  mode: "simple",
  limit: 3,
  limitAction: "KICK",
  features: { antilink: null, media: null, forbidden: null, antispam: null },
  hitMerge: "max",
  weights: { antilink: 1, media: 1, forbidden: 1, antispam: 1, manual: 1 },
  flagAt: 3,
  kickAt: 5,
  decay: { mode: "off", days: 30 },
  membership: "clear",
  flag: {
    notify: "group",
    mentionAdmins: true,
    cooldownMinutes: 0,
    whileFlagged: "record",
    escalateAfter: 3,
  },
};

type PresetKey = "relaxed" | "standard" | "strict";

/** Section 6: presets replace the enforcement policy, detector config stays alone. */
const PRESET_POLICIES: Record<PresetKey, ModerationPolicy> = {
  relaxed: {
    ...DEFAULT_POLICY,
    limit: 5,
    limitAction: "FLAG",
    decay: { mode: "expire", days: 14 },
    flag: { ...DEFAULT_POLICY.flag, cooldownMinutes: 60, whileFlagged: "hold" },
  },
  standard: DEFAULT_POLICY,
  strict: {
    ...DEFAULT_POLICY,
    limit: 2,
    features: { antilink: "KICK", media: "WARN", forbidden: "WARN", antispam: "KICK" },
  },
};

/** The policy keys as flat dirty-form fields (the form saves them together). */
interface PolicyDraft {
  policyMode: ModerationPolicy["mode"];
  policyLimit: number;
  policyLimitAction: ModerationPolicy["limitAction"];
  policyLinkAction: ModerationPolicy["features"]["antilink"];
  policyMediaAction: ModerationPolicy["features"]["media"];
  policyForbiddenAction: ModerationPolicy["features"]["forbidden"];
  policySpamAction: ModerationPolicy["features"]["antispam"];
  policyHitMerge: ModerationPolicy["hitMerge"];
  policyWeightLink: number;
  policyWeightMedia: number;
  policyWeightForbidden: number;
  policyWeightSpam: number;
  policyWeightManual: number;
  policyFlagAt: number;
  policyKickAt: number;
  policyDecayMode: ModerationPolicy["decay"]["mode"];
  policyDecayDays: number;
  policyMembership: ModerationPolicy["membership"];
  policyNotify: ModerationPolicy["flag"]["notify"];
  policyMentionAdmins: boolean;
  policyCooldown: number;
  policyWhileFlagged: ModerationPolicy["flag"]["whileFlagged"];
  policyEscalateAfter: number;
}

function draftFromPolicy(policy: ModerationPolicy): PolicyDraft {
  return {
    policyMode: policy.mode,
    policyLimit: policy.limit,
    policyLimitAction: policy.limitAction,
    policyLinkAction: policy.features.antilink,
    policyMediaAction: policy.features.media,
    policyForbiddenAction: policy.features.forbidden,
    policySpamAction: policy.features.antispam,
    policyHitMerge: policy.hitMerge,
    policyWeightLink: policy.weights.antilink,
    policyWeightMedia: policy.weights.media,
    policyWeightForbidden: policy.weights.forbidden,
    policyWeightSpam: policy.weights.antispam,
    policyWeightManual: policy.weights.manual,
    policyFlagAt: policy.flagAt,
    policyKickAt: policy.kickAt,
    policyDecayMode: policy.decay.mode,
    policyDecayDays: policy.decay.days,
    policyMembership: policy.membership,
    policyNotify: policy.flag.notify,
    policyMentionAdmins: policy.flag.mentionAdmins,
    policyCooldown: policy.flag.cooldownMinutes,
    policyWhileFlagged: policy.flag.whileFlagged,
    policyEscalateAfter: policy.flag.escalateAfter,
  };
}

function policyFromDraft(draft: PolicyDraft): ModerationPolicy {
  return {
    mode: draft.policyMode,
    limit: draft.policyLimit,
    limitAction: draft.policyLimitAction,
    features: {
      antilink: draft.policyLinkAction,
      media: draft.policyMediaAction,
      forbidden: draft.policyForbiddenAction,
      antispam: draft.policySpamAction,
    },
    hitMerge: draft.policyHitMerge,
    weights: {
      antilink: draft.policyWeightLink,
      media: draft.policyWeightMedia,
      forbidden: draft.policyWeightForbidden,
      antispam: draft.policyWeightSpam,
      manual: draft.policyWeightManual,
    },
    flagAt: draft.policyFlagAt,
    kickAt: draft.policyKickAt,
    decay: { mode: draft.policyDecayMode, days: draft.policyDecayDays },
    membership: draft.policyMembership,
    flag: {
      notify: draft.policyNotify,
      mentionAdmins: draft.policyMentionAdmins,
      cooldownMinutes: draft.policyCooldown,
      whileFlagged: draft.policyWhileFlagged,
      escalateAfter: draft.policyEscalateAfter,
    },
  };
}

/** Canonical objects are built by these two functions, so JSON order is stable. */
function samePolicy(a: ModerationPolicy, b: ModerationPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function presetOf(policy: ModerationPolicy): PresetKey | "custom" {
  if (samePolicy(policy, PRESET_POLICIES.relaxed)) return "relaxed";
  if (samePolicy(policy, PRESET_POLICIES.standard)) return "standard";
  if (samePolicy(policy, PRESET_POLICIES.strict)) return "strict";
  return "custom";
}

type PolicyPatch = Record<string, unknown> & {
  features?: Record<string, unknown>;
  weights?: Record<string, unknown>;
  decay?: Record<string, unknown>;
  flag?: Record<string, unknown>;
};

/**
 * The save body: every field the current visibility allows, nested back into
 * the sparse shape the PATCH route accepts. Hidden fields are never sent, so a
 * simple+KICK draft never touches `flag.*` and a simple draft never sends
 * weights.
 */
function policyPatchForSave(
  draft: PolicyDraft,
  visibility: ModerationPolicyVisibility,
): PolicyPatch | undefined {
  const policy = policyFromDraft(draft);
  const entries: Array<[string, unknown]> = [
    ["mode", policy.mode],
    ["limit", policy.limit],
    ["limitAction", policy.limitAction],
    ["features.antilink", policy.features.antilink],
    ["features.media", policy.features.media],
    ["features.forbidden", policy.features.forbidden],
    ["features.antispam", policy.features.antispam],
    ["hitMerge", policy.hitMerge],
    ["weights.antilink", policy.weights.antilink],
    ["weights.media", policy.weights.media],
    ["weights.forbidden", policy.weights.forbidden],
    ["weights.antispam", policy.weights.antispam],
    ["weights.manual", policy.weights.manual],
    ["flagAt", policy.flagAt],
    ["kickAt", policy.kickAt],
    ["decay.mode", policy.decay.mode],
    ["decay.days", policy.decay.days],
    ["membership", policy.membership],
    ["flag.notify", policy.flag.notify],
    ["flag.mentionAdmins", policy.flag.mentionAdmins],
    ["flag.cooldownMinutes", policy.flag.cooldownMinutes],
    ["flag.whileFlagged", policy.flag.whileFlagged],
    ["flag.escalateAfter", policy.flag.escalateAfter],
  ];
  const patch: PolicyPatch = {};
  let touched = false;
  for (const [field, value] of entries) {
    if (visibility[field] === false) continue;
    touched = true;
    const parts = field.split(".");
    let node = patch as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = node[parts[i]];
      if (typeof next !== "object" || next === null) node[parts[i]] = {};
      node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts.at(-1) as string] = value;
  }
  return touched ? patch : undefined;
}

function errorsByKey(errors: ModerationPolicyFieldError[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of errors || []) {
    if (item?.field && item.message && !(item.field in map)) map[item.field] = item.message;
  }
  return map;
}

interface GroupFilters {
  antilink: Tri;
  welcome: Tri;
  media: MediaFilter;
}

const EMPTY_GROUP_FILTERS: GroupFilters = { antilink: "any", welcome: "any", media: "any" };

type GroupSort = "name" | "members";

function matchesGroup(group: GroupItem, query: string, filters: GroupFilters): boolean {
  const needle = query.trim().toLowerCase();
  if (needle) {
    const haystack = `${group.subject || ""} ${group.jid}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  const antilink = Boolean(group.antilink.enabled);
  if (filters.antilink === "on" && !antilink) return false;
  if (filters.antilink === "off" && antilink) return false;
  const welcome = Boolean(group.welcomeEnabled);
  if (filters.welcome === "on" && !welcome) return false;
  if (filters.welcome === "off" && welcome) return false;
  if (filters.media !== "any" && (group.mediaRestriction || "none") !== filters.media) return false;
  return true;
}

export const GroupsView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GroupSort>("name");
  const [filters, setFilters] = useState<GroupFilters>(EMPTY_GROUP_FILTERS);

  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [prefix, setPrefix] = useState("!");
  const inflight = useRef(new Set<string>());
  const [pending, setPending] = useState<Set<string>>(new Set());

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getGroups();
      if (res?.groups) setGroups(res.groups);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reloadToken;
    void loadGroups();
  }, [reloadToken, loadGroups]);

  useEffect(() => {
    let active = true;
    api
      .getCommands()
      .then((res) => {
        if (!active) return;
        setCommands(res.commands.filter((cmd: CommandItem) => cmd.chat === "group"));
        setPrefix(res.prefix || "!");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const applyGroup = (group: GroupItem) => {
    setGroups((prev) => prev.map((item) => (item.jid === group.jid ? group : item)));
  };

  const handleFlagged = async (
    jid: string,
    userId: string,
    action: "kick" | "clear" | "dismiss",
  ) => {
    if (inflight.current.has(jid)) throw new Error(t("saving"));
    inflight.current.add(jid);
    setPending(new Set(inflight.current));
    try {
      const res =
        action === "kick"
          ? await api.kickFlagged(jid, userId)
          : action === "clear"
            ? await api.clearFlagged(jid, userId)
            : await api.dismissFlagged(jid, userId);
      if (res?.group) applyGroup(res.group);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
      throw err;
    } finally {
      inflight.current.delete(jid);
      setPending(new Set(inflight.current));
    }
  };

  const handleUpdate = async (jid: string, updates: Partial<GroupItem>) => {
    if (inflight.current.has(jid)) throw new Error(t("saving"));
    inflight.current.add(jid);
    setPending(new Set(inflight.current));
    try {
      const res = await api.updateGroup(jid, updates);
      if (res?.group) applyGroup(res.group);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
      throw err;
    } finally {
      inflight.current.delete(jid);
      setPending(new Set(inflight.current));
    }
  };

  const visible = useMemo(() => {
    const list = groups.filter((group) => matchesGroup(group, query, filters));
    list.sort((a, b) => {
      const byName = (a.subject || a.jid).localeCompare(b.subject || b.jid, language, {
        sensitivity: "base",
      });
      if (sort === "members") return (b.memberCount || 0) - (a.memberCount || 0) || byName;
      return byName;
    });
    return list;
  }, [groups, query, filters, sort, language]);

  const resetKey = `${query}|${sort}|${filters.antilink}|${filters.welcome}|${filters.media}`;
  const { page, pageCount, pageItems, setPage, total } = usePagination(visible, 20, resetKey);

  const activeFilters =
    (filters.antilink !== "any" ? 1 : 0) +
    (filters.welcome !== "any" ? 1 : 0) +
    (filters.media !== "any" ? 1 : 0);

  const clearFilters = () => {
    setQuery("");
    setFilters(EMPTY_GROUP_FILTERS);
  };

  const showToolbar = !loading && !error && groups.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<Users size={24} />}
        title={
          <span className="inline-flex items-center gap-2">
            {t("groups")}
            <Badge tone="info">{fill(t("groupsCount"), { n: groups.length })}</Badge>
          </span>
        }
        description={t("groupsSubtitle")}
      />

      {showToolbar && (
        <Toolbar data-tour="groups-list">
          <Input
            type="search"
            name="group-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchGroups")}
            aria-label={t("searchGroups")}
            className="min-w-48 flex-1"
          />
          <SortMenu
            label={t("sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "name", label: t("sortByName") },
              { value: "members", label: t("sortByMembers") },
            ]}
          />
          <FilterButton
            label={t("filter")}
            resetLabel={t("reset")}
            activeCount={activeFilters}
            onReset={() => setFilters(EMPTY_GROUP_FILTERS)}
          >
            <RadioGroup
              label={t("thAntiLink")}
              name="group-antilink"
              value={filters.antilink}
              onChange={(antilink) => setFilters((prev) => ({ ...prev, antilink }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "on", label: t("statusEnabled") },
                { value: "off", label: t("statusDisabled") },
              ]}
            />
            <RadioGroup
              label={t("thWelcome")}
              name="group-welcome"
              value={filters.welcome}
              onChange={(welcome) => setFilters((prev) => ({ ...prev, welcome }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "on", label: t("statusEnabled") },
                { value: "off", label: t("statusDisabled") },
              ]}
            />
            <RadioGroup
              label={t("thMedia")}
              name="group-media"
              value={filters.media}
              onChange={(media) => setFilters((prev) => ({ ...prev, media }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "none", label: t("mediaNone") },
                { value: "block_all", label: t("mediaBlockAll") },
                { value: "custom", label: t("mediaCustom") },
              ]}
            />
          </FilterButton>
        </Toolbar>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy="true">
          {["g1", "g2", "g3", "g4"].map((id) => (
            <Card key={id} className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-28" />
                </div>
              </div>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </Card>
          ))}
        </div>
      )}

      {!loading && error && (
        <EmptyState
          kind="error"
          icon={<ShieldAlert size={28} />}
          description={error}
          action={
            <Button
              variant="secondary"
              icon={<RotateCcw size={16} />}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              {t("retryLoad")}
            </Button>
          }
        />
      )}

      {!loading && !error && groups.length === 0 && (
        <EmptyState
          kind="empty"
          icon={<ShieldAlert size={28} />}
          title={t("noGroupsTitle")}
          description={t("noGroupsBody")}
        />
      )}

      {!loading && !error && groups.length > 0 && visible.length === 0 && (
        <EmptyState
          kind="no-results"
          action={
            <Button variant="secondary" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <>
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
            {pageItems.map((group) => (
              <Disclosure
                key={group.jid}
                summary={
                  <span className="flex items-center gap-3">
                    <Avatar
                      src={`/dashboard/api/groups/${encodeURIComponent(group.jid)}/photo`}
                      name={group.subject || t("unnamedGroup")}
                    />
                    <span className="min-w-0 flex-1">
                      <UserText lines={2} className="block font-bold text-text-main">
                        {group.subject || t("unnamedGroup")}
                      </UserText>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <Badge>
                          {group.memberCount ?? "—"} {t("thMembers")}
                        </Badge>
                        {group.antilink.enabled && <Badge tone="info">{t("thAntiLink")}</Badge>}
                        {group.antispam.enabled && <Badge tone="ok">{t("antiSpam")}</Badge>}
                      </span>
                    </span>
                  </span>
                }
              >
                <GroupSettings
                  group={group}
                  pending={pending.has(group.jid)}
                  onSave={(patch) => handleUpdate(group.jid, patch)}
                  onFlagged={(userId, action) => handleFlagged(group.jid, userId, action)}
                  commands={commands}
                  prefix={prefix}
                />
              </Disclosure>
            ))}
          </div>

          <Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
};

function GroupSettings({
  group,
  pending,
  onSave,
  onFlagged,
  commands,
  prefix,
}: {
  group: GroupItem;
  pending: boolean;
  onSave: (patch: Partial<GroupItem>) => Promise<void>;
  onFlagged: (userId: string, action: "kick" | "clear" | "dismiss") => Promise<void>;
  commands: CommandItem[];
  prefix: string;
}) {
  const { t, language } = useI18n();
  const { permissionLabel } = useCommandLabels();
  const savedPolicy = { ...DEFAULT_POLICY, ...group.moderation_policy } as ModerationPolicy;
  const form = useDirtyForm({
    linkMode: group.antilink.mode,
    domains: group.antilink.allowed_domains.join("\n"),
    spamWindow: group.antispam.time_window,
    spamLimit: group.antispam.message_count,
    rules: group.rules,
    welcome: group.welcome_system.messages.join("\n"),
    ...draftFromPolicy(savedPolicy),
  });

  // Progressive disclosure follows the preview's visibility for the draft,
  // falling back to the saved policy's visibility until the preview answers.
  const [policyVisibility, setPolicyVisibility] = useState<ModerationPolicyVisibility>(
    group.moderation_policy_visibility ?? {},
  );
  const [policyErrors, setPolicyErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setPolicyVisibility(group.moderation_policy_visibility ?? {});
    setPolicyErrors({});
  }, [group.moderation_policy_visibility]);

  const fieldVisible = (field: string) => policyVisibility[field] !== false;
  const policyError = (field: string) => policyErrors[field];

  const presetValue = presetOf(policyFromDraft(form.draft));
  const applyPreset = (value: PresetKey | "custom") => {
    // Choosing a preset fills the form and waits for Save; it does not send.
    if (value === "custom") return;
    form.setDraft((prev) => ({ ...prev, ...draftFromPolicy(PRESET_POLICIES[value]) }));
  };
  const toggle = (patch: Partial<GroupItem>) => {
    void onSave(patch).catch(() => {});
  };
  const onOff = (
    label: string,
    checked: boolean,
    patch: (value: boolean) => Partial<GroupItem>,
  ) => (
    <Toggle
      label={label}
      checked={checked}
      disabled={pending}
      onChange={(value) => toggle(patch(value))}
    />
  );

  const previewSettings = useMemo(
    () => ({
      antilink: {
        enabled: group.antilink.enabled,
        mode: form.draft.linkMode,
        allowed_domains: form.draft.domains
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      },
      antispam: {
        enabled: group.antispam.enabled,
        time_window: form.draft.spamWindow,
        message_count: form.draft.spamLimit,
      },
      media_control: {
        enabled: group.media_control.enabled,
        blocked_types: group.media_control.blocked_types,
      },
      forbidden_words: {
        enabled: Boolean(group.forbidden_words?.enabled),
        count: group.forbidden_words?.count || 0,
      },
      moderation_policy: policyFromDraft(form.draft),
    }),
    [
      form.draft,
      group.antilink.enabled,
      group.antispam.enabled,
      group.media_control,
      group.forbidden_words,
    ],
  );

  const savedPreview =
    language === "en" ? group.moderation_summary?.en : group.moderation_summary?.ar;
  const [livePreview, setLivePreview] = useState(savedPreview || "");
  const previewKey = JSON.stringify(previewSettings);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .previewModeration(previewSettings)
        .then((res) => {
          if (cancelled) return;
          setLivePreview(language === "en" ? res.en : res.ar);
          if (res.visibility) setPolicyVisibility(res.visibility);
          setPolicyErrors(errorsByKey(res.errors));
        })
        .catch((err: any) => {
          if (cancelled) return;
          if (Array.isArray(err?.data?.errors)) setPolicyErrors(errorsByKey(err.data.errors));
          else if (savedPreview) setLivePreview(savedPreview);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewKey, language, savedPreview, previewSettings]);

  const previewText = livePreview || savedPreview || "";

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted">{t("botAdminHint")}</p>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void form.save(async (draft) => {
            try {
              const policyPatch = policyPatchForSave(draft, policyVisibility);
              await onSave({
                antilink: {
                  enabled: group.antilink.enabled,
                  mode: draft.linkMode,
                  allowed_domains: draft.domains
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
                antispam: {
                  enabled: group.antispam.enabled,
                  time_window: draft.spamWindow,
                  message_count: draft.spamLimit,
                },
                media_control: {
                  enabled: group.media_control.enabled,
                  blocked_types: group.media_control.blocked_types,
                },
                forbidden_words: {
                  enabled: Boolean(group.forbidden_words?.enabled),
                  count: group.forbidden_words?.count || 0,
                },
                welcome_system: {
                  ...group.welcome_system,
                  messages:
                    draft.welcome === group.welcome_system.messages.join("\n")
                      ? group.welcome_system.messages
                      : draft.welcome.split("\n").filter(Boolean),
                },
                rules: draft.rules,
                // Feature actions and the warn limit ride inside the policy;
                // legacy `action` keys are no longer sent (they would
                // contradict it).
                moderation_policy: policyPatch as unknown as Partial<ModerationPolicy>,
              });
              setPolicyErrors({});
            } catch (err: any) {
              if (Array.isArray(err?.data?.errors)) setPolicyErrors(errorsByKey(err.data.errors));
              throw err;
            }
          });
        }}
      >
        <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
          <Section title={t("rulesAndModeration")}>
            {onOff(t("thAntiLink"), group.antilink.enabled, (enabled) => ({
              antilink: { ...group.antilink, enabled },
            }))}
            {onOff(t("antiSpam"), group.antispam.enabled, (enabled) => ({
              antispam: { ...group.antispam, enabled },
            }))}
            {onOff(t("forbiddenWords"), Boolean(group.forbidden_words?.enabled), (enabled) => ({
              forbidden_words: {
                ...group.forbidden_words,
                enabled,
                count: group.forbidden_words?.count || 0,
              },
            }))}
            <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
              {(
                [
                  ["image", "blockImages"],
                  ["video", "blockVideos"],
                  ["audio", "blockAudio"],
                  ["sticker", "blockStickers"],
                ] as const
              ).map(([type, label]) => (
                <Toggle
                  key={type}
                  label={t(label)}
                  disabled={pending}
                  checked={
                    group.media_control.enabled && group.media_control.blocked_types.includes(type)
                  }
                  onChange={(blocked) => {
                    const types = group.media_control.enabled
                      ? group.media_control.blocked_types
                      : [];
                    const blocked_types = blocked
                      ? [...new Set([...types, type])]
                      : types.filter((value) => value !== type);
                    toggle({ media_control: { enabled: blocked_types.length > 0, blocked_types } });
                  }}
                />
              ))}
            </div>
            <Field label={t("linkMode")}>
              <Select
                aria-label={t("linkMode")}
                value={form.draft.linkMode}
                onChange={(e) => form.setField("linkMode", e.target.value)}
              >
                <option value="ALL">{t("linkAll")}</option>
                <option value="WHITELIST">{t("linkWhitelist")}</option>
                <option value="BLACKLIST">{t("linkBlacklist")}</option>
              </Select>
            </Field>
            <Field label={t("allowedDomains")}>
              <Textarea
                aria-label={t("allowedDomains")}
                dir="ltr"
                value={form.draft.domains}
                onChange={(e) => form.setField("domains", e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("spamWindow")}>
                <Input
                  aria-label={t("spamWindow")}
                  type="number"
                  min={1}
                  max={600}
                  required
                  value={form.draft.spamWindow}
                  onChange={(e) => form.setField("spamWindow", Number(e.target.value))}
                />
              </Field>
              <Field label={t("spamLimit")}>
                <Input
                  aria-label={t("spamLimit")}
                  type="number"
                  min={2}
                  max={100}
                  required
                  value={form.draft.spamLimit}
                  onChange={(e) => form.setField("spamLimit", Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="text-sm font-bold text-text-main">{t("policyBlockTitle")}</p>
            <Field label={t("policyPreset")}>
              <SegmentedControl
                aria-label={t("policyPreset")}
                value={presetValue}
                onChange={applyPreset}
                options={[
                  { value: "relaxed", label: t("presetRelaxed") },
                  { value: "standard", label: t("presetStandard") },
                  { value: "strict", label: t("presetStrict") },
                  { value: "custom", label: t("presetCustom") },
                ]}
              />
            </Field>
            <Field label={t("policyMode")} error={policyError("mode")}>
              <Select
                aria-label={t("policyMode")}
                value={form.draft.policyMode}
                onChange={(e) => {
                  const mode: ModerationPolicy["mode"] =
                    e.target.value === "severity" ? "severity" : "simple";
                  form.setField("policyMode", mode);
                  if (mode === "severity" && form.draft.policyWhileFlagged === "escalate") {
                    form.setField("policyWhileFlagged", "record");
                  }
                }}
              >
                <option value="simple">{t("policyModeSimple")}</option>
                <option value="severity">{t("policyModeSeverity")}</option>
              </Select>
            </Field>
            {fieldVisible("limit") && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("warningLimit")} error={policyError("limit")}>
                  <Input
                    aria-label={t("warningLimit")}
                    type="number"
                    min={1}
                    max={50}
                    required
                    value={form.draft.policyLimit}
                    onChange={(e) => form.setField("policyLimit", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("warningAction")} error={policyError("limitAction")}>
                  <Select
                    aria-label={t("warningAction")}
                    value={form.draft.policyLimitAction}
                    onChange={(e) =>
                      form.setField(
                        "policyLimitAction",
                        e.target.value === "FLAG" ? "FLAG" : "KICK",
                      )
                    }
                  >
                    <option value="KICK">{t("actionKick")}</option>
                    <option value="FLAG">{t("actionFlag")}</option>
                  </Select>
                </Field>
              </div>
            )}
            {fieldVisible("flagAt") && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("policyFlagAt")} error={policyError("flagAt")}>
                  <Input
                    aria-label={t("policyFlagAt")}
                    type="number"
                    min={1}
                    max={49}
                    required
                    value={form.draft.policyFlagAt}
                    onChange={(e) => form.setField("policyFlagAt", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("policyKickAt")} error={policyError("kickAt")}>
                  <Input
                    aria-label={t("policyKickAt")}
                    type="number"
                    min={2}
                    max={50}
                    required
                    value={form.draft.policyKickAt}
                    onChange={(e) => form.setField("policyKickAt", Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
            {fieldVisible("hitMerge") && (
              <Field label={t("policyHitMerge")} error={policyError("hitMerge")}>
                <Select
                  aria-label={t("policyHitMerge")}
                  value={form.draft.policyHitMerge}
                  onChange={(e) =>
                    form.setField("policyHitMerge", e.target.value === "sum" ? "sum" : "max")
                  }
                >
                  <option value="max">{t("policyHitMergeMax")}</option>
                  <option value="sum">{t("policyHitMergeSum")}</option>
                </Select>
              </Field>
            )}
            {fieldVisible("weights.antilink") && (
              <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
                <Field label={t("policyWeightLink")} error={policyError("weights.antilink")}>
                  <Input
                    aria-label={t("policyWeightLink")}
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.draft.policyWeightLink}
                    onChange={(e) => form.setField("policyWeightLink", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("policyWeightMedia")} error={policyError("weights.media")}>
                  <Input
                    aria-label={t("policyWeightMedia")}
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.draft.policyWeightMedia}
                    onChange={(e) => form.setField("policyWeightMedia", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("policyWeightForbidden")} error={policyError("weights.forbidden")}>
                  <Input
                    aria-label={t("policyWeightForbidden")}
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.draft.policyWeightForbidden}
                    onChange={(e) => form.setField("policyWeightForbidden", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("policyWeightSpam")} error={policyError("weights.antispam")}>
                  <Input
                    aria-label={t("policyWeightSpam")}
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.draft.policyWeightSpam}
                    onChange={(e) => form.setField("policyWeightSpam", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("policyWeightManual")} error={policyError("weights.manual")}>
                  <Input
                    aria-label={t("policyWeightManual")}
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.draft.policyWeightManual}
                    onChange={(e) => form.setField("policyWeightManual", Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
            {fieldVisible("features.antilink") && (
              <Field label={t("policyLinkLabel")} error={policyError("features.antilink")}>
                <Select
                  aria-label={t("policyLinkLabel")}
                  value={form.draft.policyLinkAction ?? "DEFAULT"}
                  onChange={(e) =>
                    form.setField(
                      "policyLinkAction",
                      e.target.value === "DEFAULT"
                        ? null
                        : (e.target.value as "DELETE" | "WARN" | "KICK"),
                    )
                  }
                >
                  <option value="DEFAULT">{t("policyActionDefault")}</option>
                  <option value="DELETE">{t("actionDelete")}</option>
                  <option value="WARN">{t("actionDeleteWarn")}</option>
                  <option value="KICK">{t("actionDeleteKick")}</option>
                </Select>
              </Field>
            )}
            {fieldVisible("features.media") && (
              <Field label={t("policyMediaLabel")} error={policyError("features.media")}>
                <Select
                  aria-label={t("policyMediaLabel")}
                  value={form.draft.policyMediaAction ?? "DEFAULT"}
                  onChange={(e) =>
                    form.setField(
                      "policyMediaAction",
                      e.target.value === "DEFAULT"
                        ? null
                        : (e.target.value as "DELETE" | "WARN" | "KICK"),
                    )
                  }
                >
                  <option value="DEFAULT">{t("policyActionDefault")}</option>
                  <option value="DELETE">{t("actionDelete")}</option>
                  <option value="WARN">{t("actionDeleteWarn")}</option>
                  <option value="KICK">{t("actionDeleteKick")}</option>
                </Select>
              </Field>
            )}
            {fieldVisible("features.forbidden") && (
              <Field label={t("policyForbiddenLabel")} error={policyError("features.forbidden")}>
                <Select
                  aria-label={t("policyForbiddenLabel")}
                  value={form.draft.policyForbiddenAction ?? "DEFAULT"}
                  onChange={(e) =>
                    form.setField(
                      "policyForbiddenAction",
                      e.target.value === "DEFAULT"
                        ? null
                        : (e.target.value as "DELETE" | "WARN" | "KICK"),
                    )
                  }
                >
                  <option value="DEFAULT">{t("policyActionDefault")}</option>
                  <option value="DELETE">{t("actionDelete")}</option>
                  <option value="WARN">{t("actionDeleteWarn")}</option>
                  <option value="KICK">{t("actionDeleteKick")}</option>
                </Select>
              </Field>
            )}
            {fieldVisible("features.antispam") && (
              <Field label={t("policySpamLabel")} error={policyError("features.antispam")}>
                <Select
                  aria-label={t("policySpamLabel")}
                  value={form.draft.policySpamAction ?? "DEFAULT"}
                  onChange={(e) =>
                    form.setField(
                      "policySpamAction",
                      e.target.value === "DEFAULT" ? null : (e.target.value as "WARN" | "KICK"),
                    )
                  }
                >
                  <option value="DEFAULT">{t("policyActionDefault")}</option>
                  <option value="WARN">{t("actionWarn")}</option>
                  <option value="KICK">{t("actionKick")}</option>
                </Select>
              </Field>
            )}
            <Field label={t("policyDecay")} error={policyError("decay.mode")}>
              <Select
                aria-label={t("policyDecay")}
                value={form.draft.policyDecayMode}
                onChange={(e) =>
                  form.setField(
                    "policyDecayMode",
                    e.target.value === "expire"
                      ? "expire"
                      : e.target.value === "step"
                        ? "step"
                        : "off",
                  )
                }
              >
                <option value="off">{t("policyDecayOff")}</option>
                <option value="expire">{t("policyDecayExpire")}</option>
                <option value="step">{t("policyDecayStep")}</option>
              </Select>
            </Field>
            {fieldVisible("decay.days") && (
              <Field label={t("policyDecayDays")} error={policyError("decay.days")}>
                <Input
                  aria-label={t("policyDecayDays")}
                  type="number"
                  min={1}
                  max={365}
                  required
                  value={form.draft.policyDecayDays}
                  onChange={(e) => form.setField("policyDecayDays", Number(e.target.value))}
                />
              </Field>
            )}
            <Field label={t("policyMembership")} error={policyError("membership")}>
              <Select
                aria-label={t("policyMembership")}
                value={form.draft.policyMembership}
                onChange={(e) =>
                  form.setField("policyMembership", e.target.value === "clear" ? "clear" : "keep")
                }
              >
                <option value="keep">{t("policyMembershipKeep")}</option>
                <option value="clear">{t("policyMembershipClear")}</option>
              </Select>
            </Field>
            {fieldVisible("flag.notify") && (
              <Field label={t("policyFlagNotify")} error={policyError("flag.notify")}>
                <Select
                  aria-label={t("policyFlagNotify")}
                  value={form.draft.policyNotify}
                  onChange={(e) =>
                    form.setField("policyNotify", e.target.value === "silent" ? "silent" : "group")
                  }
                >
                  <option value="group">{t("policyNotifyGroup")}</option>
                  <option value="silent">{t("policyNotifySilent")}</option>
                </Select>
              </Field>
            )}
            {fieldVisible("flag.mentionAdmins") && (
              <Checkbox
                label={t("policyMentionAdmins")}
                checked={form.draft.policyMentionAdmins}
                disabled={pending}
                onChange={(event) => form.setField("policyMentionAdmins", event.target.checked)}
              />
            )}
            {fieldVisible("flag.cooldownMinutes") && (
              <Field
                label={t("policyCooldown")}
                description={t("policyCooldownHint")}
                error={policyError("flag.cooldownMinutes")}
              >
                <Input
                  aria-label={t("policyCooldown")}
                  type="number"
                  min={0}
                  max={10080}
                  required
                  value={form.draft.policyCooldown}
                  onChange={(e) => form.setField("policyCooldown", Number(e.target.value))}
                />
              </Field>
            )}
            {fieldVisible("flag.whileFlagged") && (
              <Field label={t("policyWhileFlagged")} error={policyError("flag.whileFlagged")}>
                <Select
                  aria-label={t("policyWhileFlagged")}
                  value={form.draft.policyWhileFlagged}
                  onChange={(e) => {
                    const value =
                      e.target.value === "hold"
                        ? "hold"
                        : e.target.value === "escalate"
                          ? "escalate"
                          : "record";
                    form.setField("policyWhileFlagged", value);
                  }}
                >
                  <option value="record">{t("policyWhileFlaggedRecord")}</option>
                  <option value="hold">{t("policyWhileFlaggedHold")}</option>
                  {form.draft.policyMode === "simple" && (
                    <option value="escalate">{t("policyWhileFlaggedEscalate")}</option>
                  )}
                </Select>
              </Field>
            )}
            {fieldVisible("flag.escalateAfter") && form.draft.policyWhileFlagged === "escalate" && (
              <Field label={t("policyEscalateAfter")} error={policyError("flag.escalateAfter")}>
                <Input
                  aria-label={t("policyEscalateAfter")}
                  type="number"
                  min={1}
                  max={50}
                  required
                  value={form.draft.policyEscalateAfter}
                  onChange={(e) => form.setField("policyEscalateAfter", Number(e.target.value))}
                />
              </Field>
            )}
            <Field label={t("groupRules")}>
              <Textarea
                aria-label={t("groupRules")}
                dir="auto"
                maxLength={4000}
                value={form.draft.rules}
                onChange={(e) => form.setField("rules", e.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-bold text-text-main">{t("flaggedMembers")}</p>
              {(group.flagged_members || []).length === 0 ? (
                <p className="text-sm text-muted">{t("flaggedEmpty")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {(group.flagged_members || []).map((member: FlaggedMember) => (
                    <li
                      key={member.user_id}
                      className="flex min-w-0 items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <UserText className="block text-sm font-bold text-text-main">
                          {member.name}
                        </UserText>
                        <p className="mt-0.5 truncate text-xs text-muted" dir="ltr">
                          {member.warn_count} · {member.last_rule || "—"}
                          {member.flagged_at ? (
                            <>
                              {" · "}
                              <RelativeTime value={member.flagged_at} />
                            </>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <IconButton
                          label={t("kickFlagged")}
                          icon={<UserX size={16} />}
                          disabled={pending}
                          onClick={() => {
                            void onFlagged(member.user_id, "kick");
                          }}
                        />
                        <OverflowMenu label={t("moreActions")}>
                          <MenuItem
                            icon={<Eraser size={16} />}
                            onSelect={() => {
                              void onFlagged(member.user_id, "clear");
                            }}
                          >
                            {t("clearWarnings")}
                          </MenuItem>
                          <MenuItem
                            onSelect={() => {
                              void onFlagged(member.user_id, "dismiss");
                            }}
                          >
                            {t("dismissFlag")}
                          </MenuItem>
                        </OverflowMenu>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Field label={t("moderationPreview")} description={t("moderationPreviewHint")}>
              <div
                dir="auto"
                className="min-h-10 whitespace-pre-wrap rounded-xl border border-line bg-bg p-3 text-sm text-text-main"
              >
                {previewText}
              </div>
            </Field>
          </Section>
          <Section title={t("thWelcome")}>
            {onOff(t("thWelcome"), group.welcome_system.enabled, (enabled) => ({
              welcome_system: { ...group.welcome_system, enabled },
            }))}
            {onOff(
              t("autoApprove"),
              group.join_requests.auto_approve_enabled,
              (auto_approve_enabled) => ({ join_requests: { auto_approve_enabled } }),
            )}
            <Field label={t("welcomeMessages")}>
              <Textarea
                aria-label={t("welcomeMessages")}
                dir="auto"
                value={form.draft.welcome}
                onChange={(e) => form.setField("welcome", e.target.value)}
              />
            </Field>
          </Section>
          <FormActions
            dirty={form.dirty}
            saving={pending}
            justSaved={form.status === "saved"}
            error={form.error}
            onDiscard={form.revert}
            saveLabel={t("save")}
            discardLabel={t("discard")}
            unsavedLabel={t("unsavedChanges")}
            savedLabel={t("saved")}
          />
        </fieldset>
      </form>
      {commands.length > 0 && (
        <Disclosure summary={t("groupCommands")}>
          <ul className="flex list-none flex-col gap-3 p-0">
            {commands.map((command) => (
              <li key={command.key || command.name} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <code dir="ltr" className="font-mono text-sm font-bold text-brand-cyan">
                    {prefix}
                    {command.name}
                  </code>
                  <Badge>{permissionLabel(command.permission)}</Badge>
                  <Badge tone={command.enabled ? "ok" : "neutral"}>
                    {command.enabled ? t("statusEnabled") : t("statusDisabled")}
                  </Badge>
                </span>
                <p dir="auto" className="text-xs text-muted">
                  {command.descriptions?.[language] || command.description}
                </p>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
