import { CircleHelp, Pencil, Plus, RotateCcw, SmilePlus, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  FilterButton,
  InfoTip,
  MenuItem,
  OverflowMenu,
  PageHeader,
  Pagination,
  RadioGroup,
  RelativeTime,
  Skeleton,
  SortMenu,
  StatusPill,
  Toggle,
  Toolbar,
  UserText,
  usePagination,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { ReactionRule } from "../../types";
import { fill } from "../../utils/fill";
import {
  EMPTY_REACTION_FILTERS,
  activeFilterCount,
  displayRuleMeta,
  reactionApiCode,
  readLimits,
  ruleMatchesFilters,
  sortReactionRules,
  statusTone,
  type ReactionFilters,
  type ReactionSort,
} from "../../utils/reactionRules";
import { ReactionRuleEditor } from "./ReactionRuleEditor";

type TFn = (key: string) => string;

function failureMessage(t: TFn, err: unknown, fallback: string): string {
  const code = reactionApiCode(err);
  if (code === "REACTION_RULE_INVALID") return t("reactionErrorRuleInvalid");
  if (code === "REACTION_RULE_MISSING") return t("reactionErrorRuleMissing");
  if (code === "REACTION_RULE_CHANGED") return t("reactionErrorRuleChanged");
  if (code === "REACTION_SWITCH_INVALID") return t("reactionErrorSwitchInvalid");
  if (code === "INTERNAL") return t("reactionErrorInternal");
  return err instanceof ApiError && err.message && !reactionApiCode(err) ? err.message : fallback;
}

function statusCopy(t: TFn, code: string): { label: string; hint: string } {
  switch (code) {
    case "READY":
      return { label: t("reactionStatusReady"), hint: t("reactionStatusReadyHint") };
    case "AUTOMATION_OFF":
      return {
        label: t("reactionStatusAutomationOff"),
        hint: t("reactionStatusAutomationOffHint"),
      };
    case "RULE_OFF":
      return { label: t("reactionStatusRuleOff"), hint: t("reactionStatusRuleOffHint") };
    case "RULE_INVALID":
      return { label: t("reactionStatusRuleInvalid"), hint: t("reactionStatusRuleInvalidHint") };
    case "NOT_CONNECTED":
      return { label: t("reactionStatusNotConnected"), hint: t("reactionStatusNotConnectedHint") };
    case "ACTION_DISABLED":
      return {
        label: t("reactionStatusActionDisabled"),
        hint: t("reactionStatusActionDisabledHint"),
      };
    case "STT_DISABLED":
      return { label: t("reactionStatusSttDisabled"), hint: t("reactionStatusSttDisabledHint") };
    case "STT_KEY_MISSING":
      return {
        label: t("reactionStatusSttKeyMissing"),
        hint: t("reactionStatusSttKeyMissingHint"),
      };
    case "OWNER_NOT_LINKED":
      return {
        label: t("reactionStatusOwnerNotLinked"),
        hint: t("reactionStatusOwnerNotLinkedHint"),
      };
    case "CANDIDATE_LIMIT":
      return {
        label: t("reactionStatusCandidateLimit"),
        hint: t("reactionStatusCandidateLimitHint"),
      };
    default:
      return { label: code, hint: t("reactionStatusUnknown") };
  }
}

function outcomeLabel(t: TFn, code: string | null | undefined): string {
  switch (code) {
    case "DELIVERED":
      return t("reactionOutcomeDelivered");
    case "NO_MATCH":
      return t("reactionOutcomeNoMatch");
    case "BUSY":
      return t("reactionOutcomeBusy");
    case "ACTION_FAILED":
      return t("reactionOutcomeActionFailed");
    case "RATE_LIMIT":
      return t("reactionOutcomeRateLimit");
    case "CAPACITY":
      return t("reactionOutcomeCapacity");
    case "EVENT_MISSING":
      return t("reactionOutcomeEventMissing");
    case "DUPLICATE":
      return t("reactionOutcomeDuplicate");
    case "REACTION_CANCELLED":
      return t("reactionOutcomeReactionCancelled");
    case "REACTION_TIMEOUT":
      return t("reactionOutcomeReactionTimeout");
    case "REACTION_STALE":
      return t("reactionOutcomeReactionStale");
    case "REACTION_INACCESSIBLE":
      return t("reactionOutcomeReactionInaccessible");
    case "REACTION_FORBIDDEN":
      return t("reactionOutcomeReactionForbidden");
    case "REACTION_STT_DISABLED":
      return t("reactionOutcomeReactionSttDisabled");
    case "REACTION_DELIVERY_REFUSED":
      return t("reactionOutcomeReactionDeliveryRefused");
    case "REACTION_CAPACITY":
      return t("reactionOutcomeReactionCapacity");
    case "REACTION_IDENTITY_INVALID":
      return t("reactionOutcomeReactionIdentityInvalid");
    case "REACTION_VOICE_REQUIRED":
      return t("reactionOutcomeReactionVoiceRequired");
    case "STT_KEY_REQUIRED":
      return t("reactionOutcomeSttKeyRequired");
    case "STT_OUTPUT_INVALID":
      return t("reactionOutcomeSttOutputInvalid");
    case "MEDIA_AUDIO_INVALID":
      return t("reactionOutcomeMediaAudioInvalid");
    case "MEDIA_TOO_LARGE":
      return t("reactionOutcomeMediaTooLarge");
    case "MEDIA_NOT_AVAILABLE":
      return t("reactionOutcomeMediaNotAvailable");
    case "MEDIA_URL_INVALID":
      return t("reactionOutcomeMediaUrlInvalid");
    default:
      return code ? fill(t("reactionOutcomeUnknown"), { code }) : t("reactionNeverRan");
  }
}

function actionLabel(t: TFn, action: string): string {
  if (action === "stt") return t("reactionActionStt");
  if (action === "ping") return t("reactionActionPing");
  return "?";
}

function destinationLabel(t: TFn, mode: string): string {
  if (mode === "owner_private") return t("reactionDestOwner");
  if (mode === "same_chat") return t("reactionDestSame");
  return "?";
}

function roleLabel(t: TFn, role: string): string {
  if (role === "any") return t("reactionRoleAny");
  if (role === "owner") return t("reactionRoleOwner");
  if (role === "bot_admin") return t("reactionRoleBotAdmin");
  if (role === "group_admin") return t("reactionRoleGroupAdmin");
  if (role === "member") return t("reactionRoleMember");
  return "?";
}

function ruleTitle(rule: ReactionRule): string {
  const meta = displayRuleMeta(rule);
  return `${meta.emoji} ${rule.chatName || rule.chatJid}`.trim();
}

export const ReactionRulesView: React.FC = () => {
  const { t: tKey, language } = useI18n();
  const t = tKey as TFn;
  const { toast } = useToast();
  const [rules, setRules] = useState<ReactionRule[]>([]);
  const [automation, setAutomation] = useState(false);
  const [connected, setConnected] = useState(true);
  const [ownerLinked, setOwnerLinked] = useState(false);
  const [limitsText, setLimitsText] = useState("");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sort, setSort] = useState<ReactionSort>("priority");
  const [filters, setFilters] = useState<ReactionFilters>(EMPTY_REACTION_FILTERS);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReactionRule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReactionRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inflight = useRef(new Set<string>());
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set());
  const listSeq = useRef(0);
  const alive = useRef(true);
  const written = useRef(0);
  const autoGen = useRef(0);

  const applyOverview = useCallback(
    (res: {
      automation?: { enabled?: boolean };
      connection?: { connected?: boolean };
      owner?: { linked?: boolean };
      limits?: unknown;
      rules?: ReactionRule[];
    }) => {
      setAutomation(Boolean(res.automation?.enabled));
      setConnected(Boolean(res.connection?.connected));
      setOwnerLinked(Boolean(res.owner?.linked));
      const limits = readLimits(res.limits);
      setLimitsText(
        fill(t("reactionLimits"), {
          perReactor: limits.perReactor,
          perChat: limits.perChat,
          perRule: limits.perRule,
          windowSeconds: Math.max(1, Math.round(limits.windowMs / 1000)),
          globalJobs: limits.globalJobs,
          candidateLimit: limits.candidateLimit,
        }),
      );
      const next = res.rules ?? [];
      setRules((prev) =>
        next.map((rule) => {
          if (!inflight.current.has(rule.id)) return rule;
          const local = prev.find((item) => item.id === rule.id);
          return local ? { ...rule, enabled: local.enabled } : rule;
        }),
      );
    },
    [t],
  );

  useEffect(() => {
    const token = ++listSeq.current;
    void reloadToken;
    setLoading(true);
    api
      .getReactions()
      .then((res) => {
        if (!alive.current || listSeq.current !== token) return;
        applyOverview(res);
        setError(null);
      })
      .catch((err) => {
        if (!alive.current || listSeq.current !== token) return;
        const message = failureMessage(t, err, t("reactionLoadFailed"));
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (alive.current && listSeq.current === token) setLoading(false);
      });
    return () => {
      listSeq.current += 1;
    };
  }, [reloadToken, t, toast, applyOverview]);

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
      const res = await api.getReactions();
      if (!alive.current || listSeq.current !== token || written.current !== seen) return;
      applyOverview(res);
      setError(null);
    } catch {
      // A background refresh must not toast or replace the list with an error.
    }
  }, [applyOverview]);

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
        if (!cancelled) toast(failureMessage(t, err, t("reactionRecipientsFailed")), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const visible = useMemo(
    () =>
      sortReactionRules(
        rules.filter((rule) => ruleMatchesFilters(rule, filters)),
        sort,
        language,
      ),
    [rules, filters, sort, language],
  );

  const resetKey = `${sort}|${filters.status}|${filters.action}`;
  const { page, pageCount, pageItems, setPage, total } = usePagination(visible, 20, resetKey);

  const editorRule = editing ? (rules.find((rule) => rule.id === editing.id) ?? editing) : null;

  const handleConflict = async () => {
    toast(t("reactionErrorRuleChanged"), "warning");
    setEditorOpen(false);
    setPendingDelete(null);
    await refresh();
  };

  const toggleAutomation = async (enabled: boolean) => {
    const previous = automation;
    const gen = ++autoGen.current;
    setAutomation(enabled);
    try {
      const res = await api.setReactionAutomation(enabled);
      if (autoGen.current !== gen) return;
      setAutomation(Boolean(res.automation?.enabled));
      await refresh();
    } catch (err) {
      if (autoGen.current !== gen) return;
      setAutomation(previous);
      toast(failureMessage(t, err, t("reactionSwitchFailed")), "error");
    }
  };

  const toggleRule = async (rule: ReactionRule, enabled: boolean) => {
    if (inflight.current.has(rule.id)) return;
    written.current += 1;
    const previous = rule.enabled;
    inflight.current.add(rule.id);
    setToggling((prev) => {
      const next = new Set(prev);
      next.add(rule.id);
      return next;
    });
    setRules((list) => list.map((item) => (item.id === rule.id ? { ...item, enabled } : item)));
    try {
      const res = await api.setReactionRuleEnabled(rule.id, { revision: rule.revision, enabled });
      setRules((list) => list.map((item) => (item.id === rule.id ? res.rule : item)));
    } catch (err) {
      inflight.current.delete(rule.id);
      let applied = false;
      try {
        const res = await api.getReactions();
        if (alive.current) {
          applyOverview(res);
          setError(null);
          applied = true;
        }
      } catch {
        // Overview reload failed; fall back to the last known server value.
      }
      if (!applied) {
        setRules((list) =>
          list.map((item) => (item.id === rule.id ? { ...item, enabled: previous } : item)),
        );
      }
      if (reactionApiCode(err) === "REACTION_RULE_CHANGED") {
        toast(t("reactionErrorRuleChanged"), "warning");
      } else {
        toast(failureMessage(t, err, t("reactionToggleFailed")), "error");
      }
    } finally {
      written.current += 1;
      inflight.current.delete(rule.id);
      setToggling((prev) => {
        if (!prev.has(rule.id)) return prev;
        const next = new Set(prev);
        next.delete(rule.id);
        return next;
      });
    }
  };

  const removeRule = async () => {
    if (!pendingDelete) return;
    written.current += 1;
    setDeleting(true);
    try {
      await api.deleteReactionRule(pendingDelete.id, pendingDelete.revision);
      setRules((list) => list.filter((item) => item.id !== pendingDelete.id));
      toast(t("reactionDeleted"), "success");
      setPendingDelete(null);
    } catch (err) {
      if (reactionApiCode(err) === "REACTION_RULE_CHANGED") {
        toast(t("reactionErrorRuleChanged"), "warning");
        setPendingDelete(null);
        await refresh();
      } else {
        toast(failureMessage(t, err, t("reactionToggleFailed")), "error");
      }
    } finally {
      written.current += 1;
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<SmilePlus size={24} />}
        title={t("reaction")}
        description={t("reactionSubtitle")}
        actions={
          rules.length > 0 ? (
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              {t("reactionNew")}
            </Button>
          ) : undefined
        }
      />

      {!loading && (
        <Card className="flex flex-col gap-3">
          <Toggle
            checked={automation}
            onChange={(enabled) => void toggleAutomation(enabled)}
            label={t("reactionAutomation")}
            description={t("reactionAutomationHint")}
          />
          {limitsText ? <p className="text-xs text-muted">{limitsText}</p> : null}
          {!connected && (
            <div className="flex items-center gap-1.5">
              <Badge tone="warn">{t("reactionStatusNotConnected")}</Badge>
              <InfoTip
                label={t("reactionStatusNotConnected")}
                content={t("reactionStatusNotConnectedHint")}
              >
                <CircleHelp size={16} />
              </InfoTip>
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {!loading && !error && rules.length > 0 && (
          <Toolbar>
            <SortMenu
              label={t("reactionSort")}
              value={sort}
              onChange={setSort}
              options={[
                { value: "priority", label: t("reactionSortPriority") },
                { value: "chat", label: t("reactionSortChat") },
                { value: "newest", label: t("reactionSortNewest") },
              ]}
            />
            <FilterButton
              label={t("reactionFilter")}
              resetLabel={t("reactionReset")}
              activeCount={activeFilterCount(filters)}
              onReset={() => setFilters(EMPTY_REACTION_FILTERS)}
            >
              <RadioGroup
                label={t("reactionFilterStatus")}
                name="rx-status"
                value={filters.status}
                onChange={(status) => setFilters((prev) => ({ ...prev, status }))}
                options={[
                  { value: "any", label: t("reactionStatusAny") },
                  { value: "ready", label: t("reactionFilterReady") },
                  { value: "off", label: t("reactionFilterOff") },
                  { value: "attention", label: t("reactionFilterAttention") },
                ]}
              />
              <RadioGroup
                label={t("reactionFilterAction")}
                name="rx-action"
                value={filters.action}
                onChange={(action) => setFilters((prev) => ({ ...prev, action }))}
                options={[
                  { value: "any", label: t("reactionStatusAny") },
                  { value: "stt", label: t("reactionActionStt") },
                  { value: "ping", label: t("reactionActionPing") },
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
          <EmptyState
            kind="error"
            icon={<SmilePlus size={28} />}
            description={error}
            action={
              <Button
                variant="secondary"
                icon={<RotateCcw size={16} />}
                onClick={() => setReloadToken((value) => value + 1)}
              >
                {t("reactionRetry")}
              </Button>
            }
          />
        )}

        {!loading && !error && rules.length === 0 && (
          <EmptyState
            kind="empty"
            icon={<SmilePlus size={28} />}
            title={t("reactionEmptyTitle")}
            description={t("reactionEmptyBody")}
            action={
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                {t("reactionNew")}
              </Button>
            }
          />
        )}

        {!loading && !error && rules.length > 0 && visible.length === 0 && (
          <EmptyState
            kind="no-results"
            title={t("reactionNoResults")}
            action={
              <Button variant="secondary" onClick={() => setFilters(EMPTY_REACTION_FILTERS)}>
                {t("reactionClearFilters")}
              </Button>
            }
          />
        )}

        {!loading && !error && visible.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {pageItems.map((rule) => {
                const statuses = Array.isArray(rule.statuses) ? (rule.statuses as string[]) : [];
                const lastCode = rule.runtime?.lastCode ?? null;
                const lastAt = rule.runtime?.lastAt ?? null;
                const meta = displayRuleMeta(rule);
                const overlaps = Array.isArray(rule.overlaps) ? rule.overlaps : [];
                return (
                  <Card key={rule.id} className="flex flex-col gap-3">
                    <div className="flex items-start gap-2">
                      <span className="text-2xl leading-none" aria-hidden>
                        {meta.emoji}
                      </span>
                      <UserText as="strong" className="min-w-0 flex-1 text-sm font-bold">
                        {rule.chatName || rule.chatJid}
                      </UserText>
                      <Toggle
                        checked={rule.enabled}
                        disabled={toggling.has(rule.id)}
                        aria-label={t("reactionEnabled")}
                        onChange={(enabled) => void toggleRule(rule, enabled)}
                      />
                      <OverflowMenu label={t("reactionMore")}>
                        <MenuItem
                          icon={<Pencil size={16} />}
                          onSelect={() => {
                            setEditing(rule);
                            setEditorOpen(true);
                          }}
                        >
                          {t("reactionEdit")}
                        </MenuItem>
                        <MenuItem
                          danger
                          icon={<Trash2 size={16} />}
                          onSelect={() => setPendingDelete(rule)}
                        >
                          {t("reactionDelete")}
                        </MenuItem>
                      </OverflowMenu>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Badge>{actionLabel(t, meta.action)}</Badge>
                      <Badge>{destinationLabel(t, meta.destination)}</Badge>
                      <Badge>{roleLabel(t, meta.role)}</Badge>
                      <Badge>{fill(t("reactionPriorityBadge"), { n: rule.priority })}</Badge>
                    </div>

                    {statuses.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {statuses.map((code) => {
                          const copy = statusCopy(t, code);
                          return (
                            <span key={code} className="inline-flex items-center gap-0.5">
                              <StatusPill tone={statusTone(code)}>{copy.label}</StatusPill>
                              <InfoTip label={copy.label} content={copy.hint}>
                                <CircleHelp size={16} />
                              </InfoTip>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {overlaps.length > 0 && (
                      <p className="text-xs text-muted">
                        {fill(t("reactionOverlaps"), { n: overlaps.length })}
                      </p>
                    )}

                    <p className="text-xs text-muted">
                      {lastCode ? (
                        <>
                          {t("reactionLastOutcome")} {outcomeLabel(t, lastCode)}
                          {lastAt ? (
                            <>
                              {" "}
                              <RelativeTime value={lastAt} className="text-xs text-muted" />
                            </>
                          ) : null}
                        </>
                      ) : (
                        t("reactionNeverRan")
                      )}
                    </p>
                  </Card>
                );
              })}
            </div>
            <Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      <ReactionRuleEditor
        open={editorOpen}
        rule={editorRule}
        names={names}
        ownerLinked={ownerLinked}
        onClose={() => setEditorOpen(false)}
        onConflict={() => void handleConflict()}
        onSaved={(rule, edited) => {
          written.current += 1;
          setRules((list) => {
            const index = list.findIndex((item) => item.id === rule.id);
            if (index === -1) return [rule, ...list];
            const next = list.slice();
            next[index] = rule;
            return next;
          });
          toast(edited ? t("reactionEditedOff") : t("reactionCreated"), "success");
          setEditorOpen(false);
        }}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void removeRule()}
        title={t("reactionDeleteTitle")}
        description={
          <span dir="auto">
            {fill(t("reactionDeleteBody"), {
              name: pendingDelete ? ruleTitle(pendingDelete) : "",
            })}
          </span>
        }
        confirmLabel={t("reactionDelete")}
        cancelLabel={t("reactionCancel")}
        loading={deleting}
      />
    </div>
  );
};
