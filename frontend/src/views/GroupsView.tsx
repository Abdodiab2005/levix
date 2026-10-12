// file: frontend/src/views/GroupsView.tsx

import { RotateCcw, ShieldAlert, Users } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FilterButton,
  Input,
  PageHeader,
  Pagination,
  RadioGroup,
  SaveField,
  Select,
  Skeleton,
  SortMenu,
  Toggle,
  Toolbar,
  UserText,
  usePagination,
  useSavedValue,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { GroupItem } from "../types";
import { fill } from "../utils/fill";

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
  const antilink = Boolean(group.antilink);
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

  const normalizeGroup = (g: any): GroupItem => {
    const jid = g.jid || g.id || "";
    const antilinkEnabled =
      typeof g.antilink === "boolean"
        ? g.antilink
        : Boolean(g.antilinkEnabled ?? g.antilink?.enabled);
    return {
      ...g,
      jid,
      subject: g.subject || "",
      memberCount: g.memberCount ?? g.participants ?? 0,
      antilink: antilinkEnabled,
      antilinkEnabled,
      welcomeEnabled: Boolean(g.welcomeEnabled ?? g.welcome_system?.enabled),
      mediaRestriction: g.mediaRestriction || "none",
    };
  };

  const loadGroups = async () => {
    setLoading(true);
    try {
      const res = await api.getGroups();
      if (res?.groups) setGroups(res.groups.map(normalizeGroup));
      setError(null);
    } catch (err: any) {
      setError(err.message);
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reloadToken;
    void loadGroups();
  }, [reloadToken]);

  const handleUpdate = async (jid: string, updates: Partial<GroupItem>) => {
    setGroups((prev) => prev.map((g) => (g.jid === jid ? { ...g, ...updates } : g)));
    try {
      await api.updateGroup(jid, updates);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
      void loadGroups();
    }
  };

  const persistMedia = async (jid: string, mediaRestriction: string) => {
    await api.updateGroup(jid, { mediaRestriction });
    setGroups((prev) => prev.map((g) => (g.jid === jid ? { ...g, mediaRestriction } : g)));
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

  const renderMedia = (jid: string, value: string) => (
    <GroupMediaField
      jid={jid}
      value={value}
      noneLabel={t("mediaNone")}
      blockLabel={t("mediaBlockAll")}
      ariaLabel={t("thMedia")}
      saveLabel={t("save")}
      savedLabel={t("saved")}
      onSave={persistMedia}
    />
  );

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
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {pageItems.map((g) => (
              <Card key={g.jid} className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-blue/10 text-sm font-bold text-brand-cyan">
                    {(g.subject || "G").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <UserText lines={2} className="font-bold text-text-main">
                      {g.subject || t("unnamedGroup")}
                    </UserText>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <bdi
                        dir="ltr"
                        className="select-all rounded border border-line bg-panel-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                      >
                        {g.jid?.split("@")[0] || g.jid}
                      </bdi>
                      <Badge tone="neutral">{g.memberCount || "—"}</Badge>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-3 border-t border-line/50 pt-3">
                  <Toggle
                    label={t("thAntiLink")}
                    checked={Boolean(g.antilink)}
                    onChange={(val) => handleUpdate(g.jid, { antilink: val })}
                  />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-semibold text-text-main">{t("thMedia")}</span>
                    {renderMedia(g.jid, g.mediaRestriction || "none")}
                  </div>
                  <Toggle
                    label={t("thWelcome")}
                    checked={Boolean(g.welcomeEnabled)}
                    onChange={(val) => handleUpdate(g.jid, { welcomeEnabled: val })}
                  />
                </div>
              </Card>
            ))}
          </div>

          <Card padded={false} className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-start text-sm">
                <thead>
                  <tr className="border-b border-line bg-panel-raised text-xs font-bold uppercase tracking-wider text-muted">
                    <th className="w-[26%] px-4 py-4 text-start">{t("thGroupName")}</th>
                    <th className="w-[22%] px-4 py-4 text-start">{t("thGroupJid")}</th>
                    <th className="w-[8%] px-4 py-4 text-start">{t("thMembers")}</th>
                    <th className="w-[13%] px-4 py-4 text-center">{t("thAntiLink")}</th>
                    <th className="w-[18%] px-4 py-4 text-start">{t("thMedia")}</th>
                    <th className="w-[13%] px-4 py-4 text-center">{t("thWelcome")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {pageItems.map((g) => (
                    <tr key={g.jid} className="transition-colors hover:bg-panel-hover/50">
                      <td className="px-4 py-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-blue/10 text-sm font-bold text-brand-cyan">
                            {(g.subject || "G").charAt(0).toUpperCase()}
                          </div>
                          <UserText lines={1} className="font-bold text-text-main">
                            {g.subject || t("unnamedGroup")}
                          </UserText>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <bdi
                          dir="ltr"
                          className="block select-all truncate rounded border border-line bg-panel-raised px-2 py-1 font-mono text-xs text-muted"
                        >
                          {g.jid?.split("@")[0] || g.jid}
                        </bdi>
                      </td>
                      <td className="px-4 py-4">
                        <Badge tone="neutral">{g.memberCount || "—"}</Badge>
                      </td>
                      <td className="px-4 py-4 text-center">
                        <Toggle
                          aria-label={t("thAntiLink")}
                          checked={Boolean(g.antilink)}
                          onChange={(val) => handleUpdate(g.jid, { antilink: val })}
                        />
                      </td>
                      <td className="px-4 py-4">
                        {renderMedia(g.jid, g.mediaRestriction || "none")}
                      </td>
                      <td className="px-4 py-4 text-center">
                        <Toggle
                          aria-label={t("thWelcome")}
                          checked={Boolean(g.welcomeEnabled)}
                          onChange={(val) => handleUpdate(g.jid, { welcomeEnabled: val })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
};

function GroupMediaField({
  jid,
  value,
  noneLabel,
  blockLabel,
  ariaLabel,
  saveLabel,
  savedLabel,
  onSave,
}: {
  jid: string;
  value: string;
  noneLabel: string;
  blockLabel: string;
  ariaLabel: string;
  saveLabel: string;
  savedLabel: string;
  onSave: (jid: string, mediaRestriction: string) => Promise<void>;
}) {
  const field = useSavedValue(value);
  return (
    <SaveField
      dirty={field.dirty}
      saving={field.status === "saving"}
      justSaved={field.status === "saved"}
      error={field.error}
      onSave={() => field.save((next) => onSave(jid, next))}
      onRevert={field.revert}
      saveLabel={saveLabel}
      savedLabel={savedLabel}
    >
      <Select
        aria-label={ariaLabel}
        value={field.value}
        onChange={(event) => field.setValue(event.target.value)}
      >
        <option value="none">{noneLabel}</option>
        <option value="block_all">{blockLabel}</option>
      </Select>
    </SaveField>
  );
}
