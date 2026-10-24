// file: frontend/src/views/GroupsView.tsx

import { RotateCcw, ShieldAlert, Users } from "lucide-react";
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
  Input,
  PageHeader,
  Pagination,
  RadioGroup,
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
import type { CommandItem, GroupItem } from "../types";
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

  const handleUpdate = async (jid: string, updates: Partial<GroupItem>) => {
    if (inflight.current.has(jid)) throw new Error(t("saving"));
    inflight.current.add(jid);
    setPending(new Set(inflight.current));
    try {
      const res = await api.updateGroup(jid, updates);
      setGroups((prev) => prev.map((g) => (g.jid === jid ? res.group : g)));
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
  commands,
  prefix,
}: {
  group: GroupItem;
  pending: boolean;
  onSave: (patch: Partial<GroupItem>) => Promise<void>;
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
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted">{t("botAdminHint")}</p>
      {onOff(t("thAntiLink"), group.antilink.enabled, (enabled) => ({
        antilink: { ...group.antilink, enabled },
      }))}
      {onOff(t("antiSpam"), group.antispam.enabled, (enabled) => ({
        antispam: { ...group.antispam, enabled },
      }))}
      {onOff(t("thWelcome"), group.welcome_system.enabled, (enabled) => ({
        welcome_system: { ...group.welcome_system, enabled },
      }))}
      {onOff(
        t("autoApprove"),
        group.join_requests.auto_approve_enabled,
        (auto_approve_enabled) => ({ join_requests: { auto_approve_enabled } }),
      )}
      <Section title={t("thMedia")}>
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
                const types = group.media_control.enabled ? group.media_control.blocked_types : [];
                const blocked_types = blocked
                  ? [...new Set([...types, type])]
                  : types.filter((value) => value !== type);
                toggle({ media_control: { enabled: blocked_types.length > 0, blocked_types } });
              }}
            />
          ))}
        </div>
      </Section>
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
              },
              antispam: {
                ...group.antispam,
                time_window: draft.spamWindow,
                message_count: draft.spamLimit,
                action: draft.spamAction,
              },
              warn_system: { max_warnings: draft.warningLimit, action: draft.warningAction },
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
          <Section title={t("groupModeration")}>
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
                  <option value="NONE">{t("actionNone")}</option>
                  <option value="KICK">{t("actionKick")}</option>
                </Select>
              </Field>
            </div>
          </Section>
          <Field label={t("groupRules")}>
            <Textarea
              aria-label={t("groupRules")}
              dir="auto"
              maxLength={4000}
              value={form.draft.rules}
              onChange={(e) => form.setField("rules", e.target.value)}
            />
          </Field>
          <Field label={t("welcomeMessages")}>
            <Textarea
              aria-label={t("welcomeMessages")}
              dir="auto"
              value={form.draft.welcome}
              onChange={(e) => form.setField("welcome", e.target.value)}
            />
          </Field>
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
