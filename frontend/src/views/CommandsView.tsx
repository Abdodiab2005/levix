// file: frontend/src/views/CommandsView.tsx

import { Search, Terminal } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import {
  Button,
  Card,
  EmptyState,
  FilterButton,
  Input,
  PageHeader,
  RadioGroup,
  Skeleton,
  SortMenu,
  Toolbar,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { CommandItem, PermissionLevel } from "../types";
import { fill } from "../utils/fill";
import { CommandAliasDialog } from "./commands/CommandAliasDialog";
import { CommandMobileList } from "./commands/CommandMobileList";
import { CommandTable } from "./commands/CommandTable";
import {
  activeCommandFilterCount,
  type CommandFilters,
  type CommandScopeFilter,
  type CommandSort,
  type CommandStatusFilter,
  commandMatches,
  EMPTY_COMMAND_FILTERS,
  sortCommands,
} from "./commands/filters";
import { type CommandActions, commandId, useCommandLabels } from "./commands/shared";

// What the server sends in GET /commands `levels`, in case it ever grows one the
// panel doesn't have a label for yet (an unlabelled level still renders, as its
// raw key, rather than disappearing from the list).
const FALLBACK_LEVELS = ["MEMBERS", "ADMINS_ONLY", "ADMINS_OWNER", "OWNER_ONLY"];

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5"];

export const CommandsView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const { permissionLabel } = useCommandLabels();
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [levels, setLevels] = useState<string[]>(FALLBACK_LEVELS);
  const [prefix, setPrefix] = useState<string>("!");
  const [isEditingPrefix, setIsEditingPrefix] = useState(false);
  const [newPrefixInput, setNewPrefixInput] = useState("!");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CommandFilters>(EMPTY_COMMAND_FILTERS);
  const [sort, setSort] = useState<CommandSort>("name");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // One open row at a time keeps the catalog compact: opening a command closes the last one.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingAliasesCmd, setEditingAliasesCmd] = useState<CommandItem | null>(null);

  const loadCommands = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getCommands();
      if (res?.commands) setCommands(res.commands);
      if (res?.prefix) {
        setPrefix(res.prefix);
        setNewPrefixInput(res.prefix);
      }
      if (Array.isArray(res?.levels) && res.levels.length) setLevels(res.levels);
      setError(null);
    } catch (err: any) {
      setError(err?.message || t("loadError"));
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    loadCommands();
  }, [loadCommands]);

  const handleUpdatePrefix = async () => {
    const clean = newPrefixInput.trim();
    if (!clean || clean.length > 3) {
      toast(t("prefixValidation"), "error");
      return;
    }
    try {
      await api.updatePrefix(clean);
      setPrefix(clean);
      setIsEditingPrefix(false);
      toast(`${t("prefixUpdated")} (${clean})`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleToggleEnabled = async (cmd: CommandItem, enabled: boolean) => {
    setCommands((prev) =>
      prev.map((c) => (commandId(c) === commandId(cmd) ? { ...c, enabled, overridden: true } : c)),
    );
    try {
      await api.updateCommand(cmd.name, { enabled });
      // `t()` puts `{name}` back in — one wording per language, no inline ternary.
      toast(
        t(enabled ? "commandEnabled" : "commandDisabled").replace("{name}", cmd.name),
        "success",
      );
    } catch (err: any) {
      toast(err.message, "error");
      loadCommands();
    }
  };

  const persistPermission = async (cmd: CommandItem, permission: PermissionLevel) => {
    await api.updateCommand(cmd.name, { permission });
    setCommands((prev) =>
      prev.map((c) =>
        commandId(c) === commandId(cmd) ? { ...c, permission, overridden: true } : c,
      ),
    );
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("copied"), "success");
    } catch {
      toast(t("copyFailed"), "error");
    }
  };

  const toggleDetails = (id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
  };

  const handleAliasesSaved = (command: CommandItem, aliases: string[]) => {
    setCommands((prev) =>
      prev.map((c) => (commandId(c) === commandId(command) ? { ...c, aliases } : c)),
    );
  };

  const resetFilters = () => {
    setSearch("");
    setFilters(EMPTY_COMMAND_FILTERS);
  };

  const collator = useMemo(() => new Intl.Collator(language), [language]);
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sortCommands(
        commands.filter((command) => commandMatches(command, query, filters)),
        sort,
        collator,
      ),
    [commands, query, filters, sort, collator],
  );

  const actionCount = activeCommandFilterCount(filters);
  const hasNarrowing = query.length > 0 || actionCount > 0;

  const actions: CommandActions = {
    onToggleEnabled: (cmd, enabled) => void handleToggleEnabled(cmd, enabled),
    onEditAliases: (cmd) => setEditingAliasesCmd(cmd),
    onSavePermission: persistPermission,
    onCopy: (text) => void handleCopy(text),
  };

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        icon={<Terminal size={20} />}
        title={t("commands")}
        description={t("commandsSub")}
        actions={
          <div className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-raised px-3 py-1.5">
            <span className="text-xs font-semibold text-muted">{t("activePrefix")}:</span>
            {isEditingPrefix ? (
              <div className="inline-flex items-center gap-1.5">
                <Input
                  type="text"
                  technical
                  maxLength={3}
                  value={newPrefixInput}
                  onChange={(e) => setNewPrefixInput(e.target.value)}
                  className="w-14 text-center font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleUpdatePrefix();
                    if (e.key === "Escape") setIsEditingPrefix(false);
                  }}
                />
                <Button variant="primary" size="sm" onClick={handleUpdatePrefix}>
                  {t("save")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setIsEditingPrefix(false)}>
                  {t("cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                title={t("editPrefixHint")}
                onClick={() => {
                  setNewPrefixInput(prefix);
                  setIsEditingPrefix(true);
                }}
              >
                <span dir="ltr" className="font-mono">
                  {prefix}
                </span>
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-3" data-tour="commands-list">
        <Toolbar>
          <div className="relative min-w-48 flex-1">
            <Search size={18} className="pointer-events-none absolute start-3.5 top-3 text-muted" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="ps-10"
            />
          </div>
          <SortMenu
            label={t("sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "name", label: t("sortByName") },
              { value: "status", label: t("sortStatus") },
            ]}
          />
          <FilterButton
            label={t("filter")}
            resetLabel={t("clearFilters")}
            activeCount={actionCount}
            onReset={resetFilters}
          >
            <RadioGroup<CommandStatusFilter>
              label={t("filterStatus")}
              name="cmd-status"
              value={filters.status}
              onChange={(status) => setFilters((prev) => ({ ...prev, status }))}
              options={[
                { value: "all", label: t("statusAny") },
                { value: "on", label: t("statusEnabled") },
                { value: "off", label: t("statusDisabled") },
              ]}
            />
            <RadioGroup<CommandScopeFilter>
              label={t("filterScope")}
              name="cmd-scope"
              value={filters.scope}
              onChange={(scope) => setFilters((prev) => ({ ...prev, scope }))}
              options={[
                { value: "all", label: t("statusAny") },
                { value: "allChats", label: t("scopeAllChats") },
                { value: "groups", label: t("scopeGroupsOnly") },
                { value: "private", label: t("scopePrivateOnly") },
                { value: "groupSub", label: t("scopeGroupSub") },
                { value: "general", label: t("scopeGeneral") },
              ]}
            />
            <RadioGroup
              label={t("filterPermission")}
              name="cmd-permission"
              value={filters.permission}
              onChange={(permission) => setFilters((prev) => ({ ...prev, permission }))}
              options={[
                { value: "all", label: t("statusAny") },
                ...levels.map((level) => ({ value: level, label: permissionLabel(level) })),
                { value: "overridden", label: t("overriddenOnly") },
                { value: "locked", label: t("lockedOnly") },
              ]}
            />
          </FilterButton>
        </Toolbar>

        {!loading && !error && (
          <p aria-live="polite" className="text-xs text-muted">
            {fill(t("resultCountOf"), { n: visible.length, total: commands.length })}
          </p>
        )}
      </div>

      {loading ? (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-line/40" aria-busy="true">
            {SKELETON_ROWS.map((id) => (
              <div key={id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="ms-auto h-4 w-14" />
                <Skeleton className="h-8 w-10" />
              </div>
            ))}
          </div>
        </Card>
      ) : error && commands.length === 0 ? (
        <EmptyState
          kind="error"
          description={error}
          action={
            <Button variant="primary" onClick={() => void loadCommands()}>
              {t("retryLoad")}
            </Button>
          }
        />
      ) : commands.length === 0 ? (
        <EmptyState kind="empty" />
      ) : visible.length === 0 ? (
        <EmptyState
          kind="no-results"
          description={t("noMatchingCommands")}
          action={
            hasNarrowing ? (
              <Button variant="secondary" onClick={resetFilters}>
                {t("clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="md:hidden">
            <CommandMobileList
              commands={visible}
              prefix={prefix}
              levels={levels}
              expanded={expanded}
              onToggleDetails={toggleDetails}
              actions={actions}
            />
          </div>
          <div className="hidden md:block">
            <CommandTable
              commands={visible}
              prefix={prefix}
              levels={levels}
              expanded={expanded}
              onToggleDetails={toggleDetails}
              actions={actions}
            />
          </div>
        </Card>
      )}

      <CommandAliasDialog
        command={editingAliasesCmd}
        prefix={prefix}
        onClose={() => setEditingAliasesCmd(null)}
        onSaved={handleAliasesSaved}
      />
    </div>
  );
};
