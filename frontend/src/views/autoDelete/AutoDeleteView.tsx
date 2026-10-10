import { Eye, MessageSquareX, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import {
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  FilterButton,
  Input,
  MenuItem,
  OverflowMenu,
  PageHeader,
  RadioGroup,
  RelativeTime,
  Skeleton,
  SortMenu,
  Tabs,
  Toggle,
  Toolbar,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { AutoDeleteMatch, AutoDeleteRule } from "../../types";
import {
  AUTO_DELETE_LIMITS,
  activeFilterCount,
  EMPTY_RULE_FILTERS,
  type RuleFilters,
  type RuleSort,
  ruleLabel,
  ruleMatchesQuery,
  sortRules,
} from "../../utils/autoDelete";
import { fill } from "../../utils/fill";
import { CopiesPanel } from "./CopiesPanel";
import { RuleEditor } from "./RuleEditor";

const PREVIEW = 4;

const MATCH_LABEL: Record<AutoDeleteMatch, "matchContains" | "matchWord" | "matchExact"> = {
  contains: "matchContains",
  word: "matchWord",
  exact: "matchExact",
};

function failureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

export const AutoDeleteView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [tab, setTab] = useState<"rules" | "copies">("rules");
  const [rules, setRules] = useState<AutoDeleteRule[]>([]);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RuleSort>("newest");
  const [filters, setFilters] = useState<RuleFilters>(EMPTY_RULE_FILTERS);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AutoDeleteRule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AutoDeleteRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copyRuleId, setCopyRuleId] = useState("");
  const inflight = useRef(new Set<number>());
  const generation = useRef(new Map<number, number>());
  const listSeq = useRef(0);
  const alive = useRef(true);
  // Bumped around every write so an in-flight list refresh cannot overwrite it.
  const written = useRef(0);
  const countFormat = useMemo(() => new Intl.NumberFormat(language), [language]);

  const applyRules = useCallback((next: AutoDeleteRule[]) => {
    setRules((prev) =>
      next.map((rule) => {
        if (!inflight.current.has(rule.id)) return rule;
        const local = prev.find((item) => item.id === rule.id);
        return local ? { ...rule, enabled: local.enabled } : rule;
      }),
    );
  }, []);

  useEffect(() => {
    const token = ++listSeq.current;
    // Read so a retry (reloadToken) retriggers this effect.
    void reloadToken;
    setLoading(true);
    api
      .listAutoDeleteRules()
      .then((res) => {
        if (!alive.current || listSeq.current !== token) return;
        applyRules(res.rules);
        setError(null);
      })
      .catch((err) => {
        if (!alive.current || listSeq.current !== token) return;
        const message = failureMessage(err, t("rulesLoadFailed"));
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (alive.current && listSeq.current === token) setLoading(false);
      });
    return () => {
      listSeq.current += 1;
    };
  }, [reloadToken, t, toast, applyRules]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const token = ++listSeq.current;
    const seen = written.current;
    try {
      const res = await api.listAutoDeleteRules();
      if (!alive.current || listSeq.current !== token || written.current !== seen) return;
      applyRules(res.rules);
      setError(null);
    } catch {
      // A background refresh must not toast or replace the list with an error.
    }
  }, [applyRules]);

  useEffect(() => {
    if (loading) return;
    const pull = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    };
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", pull);
    const timer = window.setInterval(pull, 30_000);
    return () => {
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", pull);
      window.clearInterval(timer);
    };
  }, [loading, refresh]);

  useEffect(() => {
    let cancelled = false;
    api
      .getRecipients()
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const item of res.recipients) {
          if (item.name) map.set(item.id, item.name);
        }
        setNames(map);
      })
      .catch((err) => {
        if (!cancelled) toast(failureMessage(err, t("recipientsLoadFailed")), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const visible = useMemo(
    () =>
      sortRules(
        rules.filter((rule) => ruleMatchesQuery(rule, query, filters)),
        sort,
        language,
      ),
    [rules, query, filters, sort, language],
  );

  const editorRule = editing ? (rules.find((rule) => rule.id === editing.id) ?? editing) : null;

  const openCreate = () => {
    if (rules.length >= AUTO_DELETE_LIMITS.rules) {
      toast(t("rulesLimit"), "warning");
      return;
    }
    setEditing(null);
    setEditorOpen(true);
  };

  const toggleRule = async (rule: AutoDeleteRule, enabled: boolean) => {
    written.current += 1;
    const previous = rule.enabled;
    const gen = (generation.current.get(rule.id) ?? 0) + 1;
    generation.current.set(rule.id, gen);
    inflight.current.add(rule.id);
    setRules((list) => list.map((item) => (item.id === rule.id ? { ...item, enabled } : item)));
    try {
      const res = await api.updateAutoDeleteRule(rule.id, { enabled });
      if (generation.current.get(rule.id) !== gen) return;
      setRules((list) => list.map((item) => (item.id === rule.id ? res.rule : item)));
    } catch (err) {
      if (generation.current.get(rule.id) === gen) {
        setRules((list) =>
          list.map((item) => (item.id === rule.id ? { ...item, enabled: previous } : item)),
        );
        toast(failureMessage(err, t("toggleFailed")), "error");
      }
    } finally {
      written.current += 1;
      if (generation.current.get(rule.id) === gen) inflight.current.delete(rule.id);
    }
  };

  const resetCounter = async (rule: AutoDeleteRule) => {
    written.current += 1;
    try {
      const res = await api.resetAutoDeleteRule(rule.id);
      setRules((list) => list.map((item) => (item.id === rule.id ? res.rule : item)));
      toast(t("counterReset"), "success");
    } catch (err) {
      toast(failureMessage(err, t("toggleFailed")), "error");
    } finally {
      written.current += 1;
    }
  };

  const removeRule = async () => {
    if (!pendingDelete) return;
    written.current += 1;
    setDeleting(true);
    try {
      await api.deleteAutoDeleteRule(pendingDelete.id);
      setRules((list) => list.filter((item) => item.id !== pendingDelete.id));
      if (copyRuleId === String(pendingDelete.id)) setCopyRuleId("");
      toast(t("ruleDeleted"), "success");
      setPendingDelete(null);
    } catch (err) {
      toast(failureMessage(err, t("toggleFailed")), "error");
    } finally {
      written.current += 1;
      setDeleting(false);
    }
  };

  const scopeLabel = (rule: AutoDeleteRule) => {
    if (rule.chatScope === "groups") return t("chatsGroups");
    if (rule.chatScope === "private") return t("chatsPrivate");
    return t("chatsAll");
  };

  const sendersLabel = (rule: AutoDeleteRule) => {
    if (rule.senders.mode === "everyone") return t("sendersEveryone");
    if (rule.senders.list.length === 1) return t("oneContact");
    return fill(t("sendersCount"), { n: rule.senders.list.length });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<MessageSquareX size={24} />}
        title={t("autoDelete")}
        description={t("autoDeleteSubtitle")}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
            {t("newRule")}
          </Button>
        }
      />

      <Tabs
        aria-label={t("autoDelete")}
        className="overflow-x-auto"
        value={tab}
        onChange={setTab}
        options={[
          { value: "rules", label: t("rulesTab") },
          { value: "copies", label: t("copiesTab") },
        ]}
      />

      {tab === "rules" && (
        <div className="flex flex-col gap-3">
          {!loading && rules.length > 0 && (
            <Toolbar>
              <Input
                type="search"
                name="q"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchRules")}
                aria-label={t("searchRules")}
                className="min-w-48 flex-1"
              />
              <SortMenu
                label={t("sort")}
                value={sort}
                onChange={setSort}
                options={[
                  { value: "newest", label: t("sortNewest") },
                  { value: "name", label: t("sortByName") },
                  { value: "deleted", label: t("sortMostDeleted") },
                  { value: "last", label: t("sortLastDeleted") },
                ]}
              />
              <FilterButton
                label={t("filter")}
                resetLabel={t("reset")}
                activeCount={activeFilterCount(filters)}
                onReset={() => setFilters(EMPTY_RULE_FILTERS)}
              >
                <RadioGroup
                  label={t("filterStatus")}
                  name="ad-status"
                  value={filters.enabled}
                  onChange={(enabled) => setFilters((prev) => ({ ...prev, enabled }))}
                  options={[
                    { value: "any", label: t("statusAny") },
                    { value: "on", label: t("statusEnabled") },
                    { value: "off", label: t("statusDisabled") },
                  ]}
                />
                <RadioGroup
                  label={t("filterChat")}
                  name="ad-scope"
                  value={filters.chatScope}
                  onChange={(chatScope) => setFilters((prev) => ({ ...prev, chatScope }))}
                  options={[
                    { value: "any", label: t("statusAny") },
                    { value: "all", label: t("chatsAll") },
                    { value: "groups", label: t("chatsGroups") },
                    { value: "private", label: t("chatsPrivate") },
                  ]}
                />
                <RadioGroup
                  label={t("filterSender")}
                  name="ad-senders"
                  value={filters.senders}
                  onChange={(senders) => setFilters((prev) => ({ ...prev, senders }))}
                  options={[
                    { value: "any", label: t("statusAny") },
                    { value: "everyone", label: t("sendersEveryone") },
                    { value: "selected", label: t("sendersSelected") },
                  ]}
                />
              </FilterButton>
            </Toolbar>
          )}

          {loading && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy="true">
              {["s1", "s2", "s3", "s4"].map((id) => (
                <Card key={id} className="flex flex-col gap-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-8 w-24" />
                </Card>
              ))}
            </div>
          )}

          {!loading && error && rules.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-10">
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              <Button onClick={() => setReloadToken((value) => value + 1)}>{t("retryLoad")}</Button>
            </div>
          )}

          {!loading && !error && rules.length === 0 && (
            <EmptyState
              icon={<MessageSquareX size={28} />}
              title={t("noRulesTitle")}
              description={t("noRulesBody")}
              action={
                <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
                  {t("newRule")}
                </Button>
              }
            />
          )}

          {!loading && rules.length > 0 && visible.length === 0 && (
            <EmptyState title={t("noRulesMatch")} />
          )}

          {!loading && visible.length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {visible.map((rule) => {
                const label = ruleLabel(rule);
                const extra = Math.max(0, rule.keywords.length - PREVIEW);
                return (
                  <Card key={rule.id} className="flex flex-col gap-3">
                    <div className="flex items-start gap-2">
                      <h3 dir="auto" className="min-w-0 flex-1 truncate text-sm font-bold">
                        {label || "—"}
                      </h3>
                      <Toggle
                        checked={rule.enabled}
                        aria-label={t("ruleEnabled")}
                        onChange={(enabled) => void toggleRule(rule, enabled)}
                      />
                      <OverflowMenu label={t("more")}>
                        <MenuItem
                          icon={<Pencil size={16} />}
                          onSelect={() => {
                            setEditing(rule);
                            setEditorOpen(true);
                          }}
                        >
                          {t("edit")}
                        </MenuItem>
                        <MenuItem
                          icon={<RotateCcw size={16} />}
                          onSelect={() => void resetCounter(rule)}
                        >
                          {t("resetCounter")}
                        </MenuItem>
                        {rule.keepCopy && (
                          <MenuItem
                            icon={<Eye size={16} />}
                            onSelect={() => {
                              setCopyRuleId(String(rule.id));
                              setTab("copies");
                            }}
                          >
                            {t("viewCopies")}
                          </MenuItem>
                        )}
                        <MenuItem
                          danger
                          icon={<Trash2 size={16} />}
                          onSelect={() => setPendingDelete(rule)}
                        >
                          {t("delete")}
                        </MenuItem>
                      </OverflowMenu>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {rule.keywords.slice(0, PREVIEW).map((word) => (
                        <Chip key={word}>{word}</Chip>
                      ))}
                      {extra > 0 && <Badge>{fill(t("moreKeywords"), { n: extra })}</Badge>}
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Badge>{t(MATCH_LABEL[rule.match])}</Badge>
                      <Badge>{scopeLabel(rule)}</Badge>
                      <Badge>{sendersLabel(rule)}</Badge>
                    </div>

                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-2xl font-bold tabular-nums text-text-main">
                        {countFormat.format(rule.deletedCount)}
                      </span>
                      <span className="text-xs text-muted">{t("deletedLabel")}</span>
                      <span className="ms-auto text-xs text-muted">
                        {rule.lastDeletedAt ? (
                          <>
                            {t("lastDeleted")} <RelativeTime value={rule.lastDeletedAt} />
                          </>
                        ) : (
                          t("neverDeleted")
                        )}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "copies" && (
        <CopiesPanel
          rules={rules}
          names={names}
          ruleId={copyRuleId}
          onRuleIdChange={setCopyRuleId}
        />
      )}

      <RuleEditor
        open={editorOpen}
        rule={editorRule}
        names={names}
        onClose={() => setEditorOpen(false)}
        onSaved={(rule) => {
          written.current += 1;
          setRules((list) => {
            const index = list.findIndex((item) => item.id === rule.id);
            if (index === -1) return [rule, ...list];
            const next = list.slice();
            next[index] = rule;
            return next;
          });
          toast(t("ruleSaved"), "success");
          setEditorOpen(false);
        }}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void removeRule()}
        title={t("deleteRuleTitle")}
        description={
          <span dir="auto">
            {fill(t("deleteRuleBody"), {
              name: pendingDelete ? ruleLabel(pendingDelete) : "",
            })}
          </span>
        }
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        loading={deleting}
      />
    </div>
  );
};
