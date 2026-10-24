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
import type { CommandItem, FlaggedMember, GroupItem } from "../types";
import { fill } from "../utils/fill";
import { useCommandLabels } from "./commands/shared";

type Tri = "any" | "on" | "off";
type MediaFilter = "any" | "none" | "block_all" | "custom";

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
        <Toolbar>
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
  const form = useDirtyForm({
    linkMode: group.antilink.mode,
    domains: group.antilink.allowed_domains.join("\n"),
    spamWindow: group.antispam.time_window,
    spamLimit: group.antispam.message_count,
    spamAction: group.antispam.action,
    warningLimit: group.warn_system.max_warnings,
    warningAction: group.warn_system.action,
    linkAction: group.antilink.action || "WARN",
    mediaAction: group.media_control.action || "WARN",
    wordsAction: group.forbidden_words?.action || "WARN",
    rules: group.rules,
    welcome: group.welcome_system.messages.join("\n"),
  });
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
        action: form.draft.linkAction,
      },
      antispam: {
        enabled: group.antispam.enabled,
        time_window: form.draft.spamWindow,
        message_count: form.draft.spamLimit,
        action: form.draft.spamAction,
      },
      media_control: { ...group.media_control, action: form.draft.mediaAction },
      warn_system: {
        max_warnings: form.draft.warningLimit,
        action: form.draft.warningAction,
      },
      forbidden_words: {
        enabled: Boolean(group.forbidden_words?.enabled),
        count: group.forbidden_words?.count || 0,
        action: form.draft.wordsAction,
      },
      moderation: {
        forbiddenWords: {
          enabled: Boolean(group.forbidden_words?.enabled),
          list: Array.from({ length: group.forbidden_words?.count || 0 }),
          action: form.draft.wordsAction,
        },
      },
    }),
    [
      form.draft.linkMode,
      form.draft.domains,
      form.draft.spamWindow,
      form.draft.spamLimit,
      form.draft.spamAction,
      form.draft.warningLimit,
      form.draft.warningAction,
      form.draft.linkAction,
      form.draft.mediaAction,
      form.draft.wordsAction,
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
          if (!cancelled) setLivePreview(language === "en" ? res.en : res.ar);
        })
        .catch(() => {
          if (!cancelled && savedPreview) setLivePreview(savedPreview);
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
            await onSave({
              antilink: {
                ...group.antilink,
                mode: draft.linkMode,
                allowed_domains: draft.domains
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                action: draft.linkAction,
              },
              antispam: {
                ...group.antispam,
                time_window: draft.spamWindow,
                message_count: draft.spamLimit,
                action: draft.spamAction,
              },
              media_control: { ...group.media_control, action: draft.mediaAction },
              warn_system: { max_warnings: draft.warningLimit, action: draft.warningAction },
              forbidden_words: {
                enabled: Boolean(group.forbidden_words?.enabled),
                count: group.forbidden_words?.count || 0,
                action: draft.wordsAction,
              },
              welcome_system: {
                ...group.welcome_system,
                messages:
                  draft.welcome === group.welcome_system.messages.join("\n")
                    ? group.welcome_system.messages
                    : draft.welcome.split("\n").filter(Boolean),
              },
              rules: draft.rules,
            });
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
              forbidden_words: { ...group.forbidden_words, enabled, count: group.forbidden_words?.count || 0 },
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
            <Field label={t("linkAction")}>
              <Select
                aria-label={t("linkAction")}
                value={form.draft.linkAction}
                onChange={(e) => form.setField("linkAction", e.target.value)}
              >
                <option value="DELETE">{t("actionDelete")}</option>
                <option value="WARN">{t("actionDeleteWarn")}</option>
                <option value="KICK">{t("actionDeleteKick")}</option>
              </Select>
            </Field>
            <Field label={t("mediaAction")}>
              <Select
                aria-label={t("mediaAction")}
                value={form.draft.mediaAction}
                onChange={(e) => form.setField("mediaAction", e.target.value)}
              >
                <option value="DELETE">{t("actionDelete")}</option>
                <option value="WARN">{t("actionDeleteWarn")}</option>
                <option value="KICK">{t("actionDeleteKick")}</option>
              </Select>
            </Field>
            <Field label={t("wordsAction")}>
              <Select
                aria-label={t("wordsAction")}
                value={form.draft.wordsAction}
                onChange={(e) => form.setField("wordsAction", e.target.value)}
              >
                <option value="DELETE">{t("actionDelete")}</option>
                <option value="WARN">{t("actionDeleteWarn")}</option>
                <option value="KICK">{t("actionDeleteKick")}</option>
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
            <Field label={t("spamAction")}>
              <Select
                aria-label={t("spamAction")}
                value={form.draft.spamAction}
                onChange={(e) => form.setField("spamAction", e.target.value)}
              >
                <option value="WARN">{t("actionWarn")}</option>
                <option value="KICK">{t("actionKick")}</option>
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("warningLimit")}>
                <Input
                  aria-label={t("warningLimit")}
                  type="number"
                  min={1}
                  max={50}
                  required
                  value={form.draft.warningLimit}
                  onChange={(e) => form.setField("warningLimit", Number(e.target.value))}
                />
              </Field>
              <Field label={t("warningAction")}>
                <Select
                  aria-label={t("warningAction")}
                  value={form.draft.warningAction}
                  onChange={(e) => form.setField("warningAction", e.target.value)}
                >
                  <option value="FLAG">{t("actionFlag")}</option>
                  <option value="KICK">{t("actionKick")}</option>
                </Select>
              </Field>
            </div>
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
