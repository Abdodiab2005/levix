// file: frontend/src/views/plus/AutoReplyTab.tsx
import { Bot, Pencil, Plus, RotateCcw, Trash2, User, Users } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { BidiText, RecipientPicker } from "../../components/RecipientPicker";
import {
  Badge,
  Button,
  Card,
  ChipInput,
  type ChipRejectReason,
  CodeText,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  Input,
  ListRow,
  LoadingState,
  MenuItem,
  OverflowMenu,
  SegmentedControl,
  Select,
  Textarea,
  Toggle,
  UserText,
  useDirtyForm,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { MessageKey } from "../../i18n/translations";
import type { DashboardRecipient } from "../../types";
import { fill } from "../../utils/fill";
import { recipientParts } from "../../utils/recipientLabel";
import { AutoReplyChatEditor } from "./AutoReplyChatEditor";
import { plusErrorCode, plusErrorMessage, plusGet, plusPut } from "./plusApi";
import {
  type AutoReplyFormData,
  addAutoReplyChat,
  addExcludedChat,
  autoReplyFormDataFrom,
  createWriteQueue,
  describeAutoReplyPeers,
  fallbackRecipientForJid,
  isPhoneTitle,
  policyDraftFrom,
  reconcileAutoReplyDraft,
  removeAutoReplyChat,
  removeExcludedChat,
  sameAutoReplyFormFields,
  saveAutoReplyForm,
  saveAutoReplyPatch,
  setAutoReplyScopeMode,
} from "./plusUiLogic";
import {
  type AutoReplyChat,
  type AutoReplyConfig,
  type AutoReplyPolicy,
  type AutoReplyScopeMode,
  type AutoReplyTrigger,
  DEFAULT_AUTO_REPLY_POLICY,
  isAutoReplyRevision,
  PLUS_LIMITS,
  normalizeAutoReplyConfig,
} from "./types";

const TRIGGERS: AutoReplyTrigger[] = ["all", "mention", "keywords"];

export function AutoReplyTab({ onInactive }: { onInactive: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AutoReplyConfig | null>(null);
  const [recipients, setRecipients] = useState<DashboardRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken re-runs the load on demand.
  useEffect(() => {
    let live = true;
    setLoading(true);
    plusGet<AutoReplyConfig>("/auto-reply")
      .then((result) => {
        if (!live) return;
        setConfig(normalizeAutoReplyConfig(result));
        setError(null);
      })
      .catch((err) => {
        if (!live) return;
        const code = plusErrorCode(err);
        if (code === "inactive") onInactive();
        setError(plusErrorMessage(t, err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken, onInactive, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken re-runs the load on demand.
  useEffect(() => {
    let live = true;
    api
      .getRecipients()
      .then((res) => {
        if (live) setRecipients(res.recipients ?? []);
      })
      .catch(() => {
        // Fallback labels handle unknown JIDs when WhatsApp directory is unavailable.
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  if (loading && !config) return <LoadingState text={t("loading")} />;
  if (error && !config) {
    return (
      <EmptyState
        kind="error"
        icon={<Bot size={28} />}
        description={error}
        action={
          <Button
            variant="secondary"
            icon={<RotateCcw size={16} />}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t("retry")}
          </Button>
        }
      />
    );
  }
  if (!config) return null;

  return (
    <AutoReplyForm
      config={config}
      recipients={recipients}
      onSaved={setConfig}
      onInactive={onInactive}
    />
  );
}

function AutoReplyForm({
  config,
  recipients,
  onSaved,
  onInactive,
}: {
  config: AutoReplyConfig;
  recipients: DashboardRecipient[];
  onSaved: (next: AutoReplyConfig) => void;
  onInactive: () => void;
}) {
  const { t, language } = useI18n();
  const scopeMode: AutoReplyScopeMode = config.scopeMode ?? "only";
  const chatsKey = useMemo(() => JSON.stringify(config.chats), [config.chats]);
  const excludedKey = useMemo(
    () => JSON.stringify(config.excludedChats ?? []),
    [config.excludedChats],
  );
  const policyDraft = useMemo(() => policyDraftFrom(config.policy), [config.policy]);
  const policyKey = useMemo(() => JSON.stringify(policyDraft), [policyDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content so a new object with the same values keeps the baseline.
  const savedBaseline = useMemo<AutoReplyFormData>(
    () => ({
      baseRevision: isAutoReplyRevision(config.revision) ? config.revision : undefined,
      scopeMode,
      globalPerHour: config.globalPerHour,
      chats: config.chats,
      excludedChats: config.excludedChats ?? [],
      policy: policyDraft,
    }),
    [config.revision, scopeMode, config.globalPerHour, chatsKey, excludedKey, policyKey],
  );

  const form = useDirtyForm<AutoReplyFormData>(
    savedBaseline,
    "plusExtErrorFailed",
    plusErrorMessage,
  );
  const prevBaselineRef = useRef(savedBaseline);
  const submittedDraftRef = useRef<AutoReplyFormData | null>(null);
  const conflictReloadRef = useRef(false);
  const appliedBaseRevisionRef = useRef<number | undefined>(undefined);
  const formSaving = form.status === "saving";

  useEffect(() => {
    if (prevBaselineRef.current !== savedBaseline) {
      const prev = prevBaselineRef.current;
      prevBaselineRef.current = savedBaseline;
      const submitted = submittedDraftRef.current;
      const conflictReload = conflictReloadRef.current;
      const appliedBaseRevision = appliedBaseRevisionRef.current;
      submittedDraftRef.current = null;
      conflictReloadRef.current = false;
      appliedBaseRevisionRef.current = undefined;
      form.setDraft(
        reconcileAutoReplyDraft({
          draft: form.draft,
          previousBaseline: prev,
          nextBaseline: savedBaseline,
          submittedDraft: submitted,
          conflictReload,
          appliedBaseRevision,
        }),
      );
    }
  }, [savedBaseline, form.draft, form.setDraft]);

  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [togglingKill, setTogglingKill] = useState(false);
  const [togglingGroups, setTogglingGroups] = useState(false);
  const [togglingMemory, setTogglingMemory] = useState(false);
  const [confirmPolicyMemory, setConfirmPolicyMemory] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const writeQueueRef = useRef(createWriteQueue());
  const savedRef = useRef(config);
  savedRef.current = config;

  const [editor, setEditor] = useState<{ chat: AutoReplyChat } | null>(null);
  const [pickerMode, setPickerMode] = useState<"only" | "except" | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [policyKeywordError, setPolicyKeywordError] = useState<string | null>(null);
  const [policyCooldownError, setPolicyCooldownError] = useState<string | null>(null);
  const [policySenderError, setPolicySenderError] = useState<string | null>(null);
  const [policyChatError, setPolicyChatError] = useState<string | null>(null);

  const chats = form.draft.chats;
  const excludedChats = form.draft.excludedChats;
  const atChatLimit = chats.length >= PLUS_LIMITS.autoReplyChats;
  const atExcludedLimit = excludedChats.length >= PLUS_LIMITS.autoReplyExcludedChats;

  const peerMap = useMemo(
    () =>
      describeAutoReplyPeers(
        [...chats.map((chat) => chat.jid), ...excludedChats],
        recipients,
        (key) => t(key as MessageKey),
        language,
      ),
    [chats, excludedChats, recipients, t, language],
  );

  const resolvePeer = (jid: string) =>
    peerMap.get(jid) ??
    recipientParts(fallbackRecipientForJid(jid), (key) => t(key as MessageKey), language);

  const triggerLabel = (value: AutoReplyTrigger) =>
    value === "mention"
      ? t("plusTriggerMention")
      : value === "keywords"
        ? t("plusTriggerKeywords")
        : t("plusTriggerAll");

  const scopeHint =
    form.draft.scopeMode === "all"
      ? t("plusAutoReplyScopeAllHint")
      : form.draft.scopeMode === "except"
        ? t("plusAutoReplyScopeExceptHint")
        : t("plusAutoReplyScopeOnlyHint");

  async function applyImmediateToggle(
    buildPatch: (current: AutoReplyConfig) => Partial<AutoReplyConfig>,
    setBusy: (busy: boolean) => void,
  ) {
    setBusy(true);
    setToggleError(null);
    try {
      const { config: normalized, appliedBaseRevision } = await writeQueueRef.current.enqueue(() =>
        saveAutoReplyPatch({
          current: savedRef.current,
          patch: buildPatch,
          put: (body) => plusPut<AutoReplyConfig>("/auto-reply", body),
          load: () => plusGet<AutoReplyConfig>("/auto-reply"),
          isConflict: (err) => plusErrorCode(err) === "CONFLICT",
        }),
      );
      savedRef.current = normalized;
      submittedDraftRef.current = null;
      conflictReloadRef.current = false;
      appliedBaseRevisionRef.current = appliedBaseRevision;
      onSaved(normalized);
    } catch (err) {
      if (plusErrorCode(err) === "inactive") onInactive();
      setToggleError(plusErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  function rejectPolicyKeyword(reason: ChipRejectReason | null) {
    if (reason === "long") setPolicyKeywordError(t("plusAutoReplyKeywordTooLong"));
    else if (reason === "max") setPolicyKeywordError(t("plusAutoReplyKeywordMax"));
    else if (reason === "duplicate") setPolicyKeywordError(t("plusAutoReplyKeywordDuplicate"));
    else setPolicyKeywordError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (formSaving) return;
    const range = (min: number, max: number) => fill(t("plusAutoReplyRange"), { min, max });
    const limit = form.draft.globalPerHour;
    const validGlobal =
      Number.isInteger(limit) &&
      limit >= PLUS_LIMITS.globalPerHour.min &&
      limit <= PLUS_LIMITS.globalPerHour.max;

    const p = form.draft.policy;
    const validCooldown =
      Number.isInteger(p.cooldownSeconds) &&
      p.cooldownSeconds >= PLUS_LIMITS.cooldownSeconds.min &&
      p.cooldownSeconds <= PLUS_LIMITS.cooldownSeconds.max;
    const validSender =
      Number.isInteger(p.perSenderPerHour) &&
      p.perSenderPerHour >= PLUS_LIMITS.perSenderPerHour.min &&
      p.perSenderPerHour <= PLUS_LIMITS.perSenderPerHour.max;
    const validChat =
      Number.isInteger(p.perChatPerHour) &&
      p.perChatPerHour >= PLUS_LIMITS.perChatPerHour.min &&
      p.perChatPerHour <= PLUS_LIMITS.perChatPerHour.max;

    setLimitError(
      validGlobal ? null : range(PLUS_LIMITS.globalPerHour.min, PLUS_LIMITS.globalPerHour.max),
    );
    setPolicyCooldownError(
      validCooldown
        ? null
        : range(PLUS_LIMITS.cooldownSeconds.min, PLUS_LIMITS.cooldownSeconds.max),
    );
    setPolicySenderError(
      validSender
        ? null
        : range(PLUS_LIMITS.perSenderPerHour.min, PLUS_LIMITS.perSenderPerHour.max),
    );
    setPolicyChatError(
      validChat ? null : range(PLUS_LIMITS.perChatPerHour.min, PLUS_LIMITS.perChatPerHour.max),
    );

    if (!validGlobal || !validCooldown || !validSender || !validChat) return;

    const submittedSnapshot: AutoReplyFormData = {
      baseRevision: form.draft.baseRevision,
      scopeMode: form.draft.scopeMode,
      globalPerHour: form.draft.globalPerHour,
      chats: form.draft.chats,
      excludedChats: form.draft.excludedChats,
      policy: { ...form.draft.policy, keywords: [...form.draft.policy.keywords] },
    };

    void form.save(async (draft) => {
      const baseRevision =
        draft.baseRevision !== undefined ? draft.baseRevision : submittedSnapshot.baseRevision;
      try {
        const outcome = await writeQueueRef.current.enqueue(() =>
          saveAutoReplyForm({
            current: savedRef.current,
            baseRevision,
            patch: (current) => ({
              scopeMode: draft.scopeMode,
              globalPerHour: draft.globalPerHour,
              chats: draft.chats,
              excludedChats: draft.excludedChats,
              policy: {
                ...draft.policy,
                instructions: draft.policy.instructions.trim(),
                globalMemory: { read: current.policy?.globalMemory?.read ?? false },
              },
            }),
            put: (body) => plusPut<AutoReplyConfig>("/auto-reply", body),
            load: () => plusGet<AutoReplyConfig>("/auto-reply"),
            isConflict: (err) => plusErrorCode(err) === "CONFLICT",
          }),
        );
        savedRef.current = outcome.config;
        if (!outcome.ok) {
          submittedDraftRef.current = null;
          appliedBaseRevisionRef.current = undefined;
          const reloadedBaseline = autoReplyFormDataFrom(outcome.config);
          const baselineChanged =
            reloadedBaseline.baseRevision !== savedBaseline.baseRevision ||
            !sameAutoReplyFormFields(reloadedBaseline, savedBaseline);
          conflictReloadRef.current = baselineChanged;
          onSaved(outcome.config);
          form.setDraft(baselineChanged ? reloadedBaseline : savedBaseline);
          throw outcome.error;
        }
        submittedDraftRef.current = submittedSnapshot;
        conflictReloadRef.current = false;
        appliedBaseRevisionRef.current = undefined;
        onSaved(outcome.config);
      } catch (err) {
        submittedDraftRef.current = null;
        appliedBaseRevisionRef.current = undefined;
        if (plusErrorCode(err) === "inactive") onInactive();
        throw err;
      }
    });
  }

  function toggleChat(chat: AutoReplyChat) {
    form.setField(
      "chats",
      chats.map((item) => (item.jid === chat.jid ? { ...item, enabled: !item.enabled } : item)),
    );
  }

  const globalMemoryRead = Boolean(config.policy?.globalMemory?.read);
  const showPolicyKeywords =
    form.draft.policy.privateTrigger === "keywords" ||
    form.draft.policy.groupTrigger === "keywords";

  return (
    <Card className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-3">
          <Toggle
            checked={config.enabled}
            disabled={togglingEnabled}
            label={t("plusAutoReplyEnabled")}
            onChange={(value) =>
              void applyImmediateToggle(() => ({ enabled: value }), setTogglingEnabled)
            }
          />
          <Toggle
            checked={config.killSwitch}
            disabled={togglingKill}
            label={t("plusAutoReplyKill")}
            description={t("plusAutoReplyKillHint")}
            onChange={(value) =>
              void applyImmediateToggle(() => ({ killSwitch: value }), setTogglingKill)
            }
          />
          <Toggle
            checked={Boolean(config.groupsEnabled)}
            disabled={togglingGroups}
            label={t("plusAutoReplyGroupsEnabled")}
            description={t("plusAutoReplyGroupsEnabledHint")}
            onChange={(value) =>
              void applyImmediateToggle(() => ({ groupsEnabled: value }), setTogglingGroups)
            }
          />
          {toggleError && (
            <p role="alert" className="text-xs text-danger">
              {toggleError}
            </p>
          )}
        </div>

        <Field label={t("plusAutoReplyScope")} description={scopeHint}>
          <SegmentedControl
            aria-label={t("plusAutoReplyScope")}
            className={
              formSaving
                ? "pointer-events-none flex w-full flex-wrap opacity-50"
                : "flex w-full flex-wrap"
            }
            value={form.draft.scopeMode}
            onChange={(mode) => {
              if (!formSaving) form.setDraft(setAutoReplyScopeMode(form.draft, mode));
            }}
            options={[
              { value: "all", label: t("plusAutoReplyScopeAll") },
              { value: "except", label: t("plusAutoReplyScopeExcept") },
              { value: "only", label: t("plusAutoReplyScopeOnly") },
            ]}
          />
        </Field>

        {form.draft.scopeMode === "only" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-text-main">{t("plusAutoReplyChats")}</p>
                <span className="text-xs text-muted tabular-nums">
                  {fill(t("plusAutoReplyChatsCount"), {
                    n: chats.length,
                    max: PLUS_LIMITS.autoReplyChats,
                  })}
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={16} />}
                disabled={formSaving || atChatLimit}
                onClick={() => setPickerMode("only")}
              >
                {t("plusAutoReplyAddChat")}
              </Button>
            </div>

            {chats.length === 0 ? (
              <EmptyState
                kind="empty"
                icon={<Bot size={26} />}
                description={t("plusAutoReplyEmpty")}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {chats.map((chat) => {
                  const peer = resolvePeer(chat.jid);
                  return (
                    <ListRow
                      key={chat.jid}
                      as="li"
                      variant="raised"
                      leading={
                        peer.kind === "group" ? (
                          <Users size={16} className="text-brand-cyan" />
                        ) : (
                          <User size={16} className="text-ok" />
                        )
                      }
                      title={
                        isPhoneTitle(peer.title) ? (
                          <CodeText>{peer.title}</CodeText>
                        ) : (
                          <UserText>{peer.title}</UserText>
                        )
                      }
                      meta={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {peer.subtitle ? <BidiText text={peer.subtitle} /> : null}
                          <span>
                            {fill(t("plusAutoReplyRowHint"), {
                              cooldown: chat.cooldownSeconds,
                              sender: chat.perSenderPerHour,
                              chat: chat.perChatPerHour,
                            })}
                          </span>
                        </span>
                      }
                      onClick={formSaving ? undefined : () => setEditor({ chat })}
                      trailing={
                        <>
                          <IconButton
                            label={t("plusAutoReplyEditChat")}
                            icon={<Pencil size={16} />}
                            disabled={formSaving}
                            onClick={() => setEditor({ chat })}
                          />
                          <OverflowMenu label={t("more")}>
                            <MenuItem disabled={formSaving} onSelect={() => toggleChat(chat)}>
                              {chat.enabled ? t("plusAutoReplyDisable") : t("plusAutoReplyEnable")}
                            </MenuItem>
                            <MenuItem
                              danger
                              disabled={formSaving}
                              icon={<Trash2 size={16} />}
                              onSelect={() => setPendingRemove(chat.jid)}
                            >
                              {t("plusAutoReplyRemove")}
                            </MenuItem>
                          </OverflowMenu>
                        </>
                      }
                    >
                      <div className="flex flex-wrap gap-1.5">
                        <Badge>{triggerLabel(chat.trigger)}</Badge>
                        <Badge tone={chat.enabled ? "ok" : "neutral"}>
                          {chat.enabled ? t("plusAutoReplyOn") : t("plusAutoReplyOff")}
                        </Badge>
                        {chat.keywords.length > 0 && (
                          <Badge>
                            {fill(t("plusAutoReplyKeywordCount"), {
                              n: chat.keywords.length,
                              max: PLUS_LIMITS.keywords,
                            })}
                          </Badge>
                        )}
                      </div>
                    </ListRow>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {form.draft.scopeMode === "except" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-text-main">
                  {t("plusAutoReplyExcludedChats")}
                </p>
                <span className="text-xs text-muted tabular-nums">
                  {fill(t("plusAutoReplyChatsCount"), {
                    n: excludedChats.length,
                    max: PLUS_LIMITS.autoReplyExcludedChats,
                  })}
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={16} />}
                disabled={formSaving || atExcludedLimit}
                onClick={() => setPickerMode("except")}
              >
                {t("plusAutoReplyAddExcluded")}
              </Button>
            </div>

            {excludedChats.length === 0 ? (
              <EmptyState
                kind="empty"
                icon={<Bot size={26} />}
                description={t("plusAutoReplyExcludedEmpty")}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {excludedChats.map((excludedJid) => {
                  const peer = resolvePeer(excludedJid);
                  return (
                    <ListRow
                      key={excludedJid}
                      as="li"
                      variant="raised"
                      leading={
                        peer.kind === "group" ? (
                          <Users size={16} className="text-brand-cyan" />
                        ) : (
                          <User size={16} className="text-ok" />
                        )
                      }
                      title={
                        isPhoneTitle(peer.title) ? (
                          <CodeText>{peer.title}</CodeText>
                        ) : (
                          <UserText>{peer.title}</UserText>
                        )
                      }
                      meta={peer.subtitle ? <BidiText text={peer.subtitle} /> : undefined}
                      trailing={
                        <IconButton
                          label={fill(t("removeContact"), { name: peer.title })}
                          icon={<Trash2 size={16} />}
                          disabled={formSaving}
                          onClick={() =>
                            form.setField(
                              "excludedChats",
                              removeExcludedChat(excludedChats, excludedJid),
                            )
                          }
                        />
                      }
                    />
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <Disclosure
          summary={<span className="text-sm font-semibold">{t("plusAutoReplyAdvanced")}</span>}
        >
          <div className="flex flex-col gap-4">
            <p className="text-xs text-muted">{t("plusAutoReplyPolicyHint")}</p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("plusAutoReplyPrivateTrigger")} htmlFor="plus-policy-private-trigger">
                <Select
                  id="plus-policy-private-trigger"
                  disabled={formSaving}
                  value={form.draft.policy.privateTrigger}
                  onChange={(event) =>
                    form.setField("policy", {
                      ...form.draft.policy,
                      privateTrigger: event.target.value as AutoReplyTrigger,
                    })
                  }
                >
                  {TRIGGERS.map((value) => (
                    <option key={value} value={value}>
                      {triggerLabel(value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("plusAutoReplyGroupTrigger")} htmlFor="plus-policy-group-trigger">
                <Select
                  id="plus-policy-group-trigger"
                  disabled={formSaving}
                  value={form.draft.policy.groupTrigger}
                  onChange={(event) =>
                    form.setField("policy", {
                      ...form.draft.policy,
                      groupTrigger: event.target.value as AutoReplyTrigger,
                    })
                  }
                >
                  {TRIGGERS.map((value) => (
                    <option key={value} value={value}>
                      {triggerLabel(value)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {showPolicyKeywords && (
              <Field
                label={t("plusAutoReplyKeywords")}
                description={t("plusAutoReplyKeywordsHint")}
                error={policyKeywordError}
              >
                <ChipInput
                  value={form.draft.policy.keywords}
                  disabled={formSaving}
                  onChange={(keywords) =>
                    form.setField("policy", { ...form.draft.policy, keywords })
                  }
                  max={PLUS_LIMITS.keywords}
                  maxLength={PLUS_LIMITS.keywordChars}
                  onReject={rejectPolicyKeyword}
                  removeLabel={(word) => fill(t("removeKeyword"), { word })}
                  countLabel={fill(t("plusAutoReplyKeywordCount"), {
                    n: form.draft.policy.keywords.length,
                    max: PLUS_LIMITS.keywords,
                  })}
                  placeholder={t("keywordsPlaceholder")}
                  aria-label={t("plusAutoReplyKeywords")}
                  aria-invalid={policyKeywordError ? true : undefined}
                />
              </Field>
            )}

            <Field
              label={t("plusAutoReplyInstructions")}
              htmlFor="plus-policy-instructions"
              description={fill(t("plusTextCount"), {
                n: form.draft.policy.instructions.length,
                max: PLUS_LIMITS.instructions,
              })}
            >
              <Textarea
                id="plus-policy-instructions"
                dir="auto"
                rows={3}
                disabled={formSaving}
                maxLength={PLUS_LIMITS.instructions}
                value={form.draft.policy.instructions}
                onChange={(event) =>
                  form.setField("policy", {
                    ...form.draft.policy,
                    instructions: event.target.value,
                  })
                }
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t("plusAutoReplyGlobalLimit")}
                htmlFor="plus-auto-reply-global"
                error={limitError}
              >
                <Input
                  id="plus-auto-reply-global"
                  type="number"
                  inputMode="numeric"
                  disabled={formSaving}
                  min={PLUS_LIMITS.globalPerHour.min}
                  max={PLUS_LIMITS.globalPerHour.max}
                  value={String(form.draft.globalPerHour)}
                  aria-invalid={limitError ? true : undefined}
                  onChange={(event) => {
                    form.setField("globalPerHour", Number(event.target.value));
                    setLimitError(null);
                  }}
                />
              </Field>
              <Field
                label={t("plusAutoReplyCooldown")}
                htmlFor="plus-policy-cooldown"
                error={policyCooldownError}
              >
                <Input
                  id="plus-policy-cooldown"
                  type="number"
                  inputMode="numeric"
                  disabled={formSaving}
                  min={PLUS_LIMITS.cooldownSeconds.min}
                  max={PLUS_LIMITS.cooldownSeconds.max}
                  value={String(form.draft.policy.cooldownSeconds)}
                  aria-invalid={policyCooldownError ? true : undefined}
                  onChange={(event) => {
                    form.setField("policy", {
                      ...form.draft.policy,
                      cooldownSeconds: Number(event.target.value),
                    });
                    setPolicyCooldownError(null);
                  }}
                />
              </Field>
              <Field
                label={t("plusAutoReplyPerSender")}
                htmlFor="plus-policy-sender"
                error={policySenderError}
              >
                <Input
                  id="plus-policy-sender"
                  type="number"
                  inputMode="numeric"
                  disabled={formSaving}
                  min={PLUS_LIMITS.perSenderPerHour.min}
                  max={PLUS_LIMITS.perSenderPerHour.max}
                  value={String(form.draft.policy.perSenderPerHour)}
                  aria-invalid={policySenderError ? true : undefined}
                  onChange={(event) => {
                    form.setField("policy", {
                      ...form.draft.policy,
                      perSenderPerHour: Number(event.target.value),
                    });
                    setPolicySenderError(null);
                  }}
                />
              </Field>
              <Field
                label={t("plusAutoReplyPerChat")}
                htmlFor="plus-policy-chat"
                error={policyChatError}
              >
                <Input
                  id="plus-policy-chat"
                  type="number"
                  inputMode="numeric"
                  disabled={formSaving}
                  min={PLUS_LIMITS.perChatPerHour.min}
                  max={PLUS_LIMITS.perChatPerHour.max}
                  value={String(form.draft.policy.perChatPerHour)}
                  aria-invalid={policyChatError ? true : undefined}
                  onChange={(event) => {
                    form.setField("policy", {
                      ...form.draft.policy,
                      perChatPerHour: Number(event.target.value),
                    });
                    setPolicyChatError(null);
                  }}
                />
              </Field>
            </div>

            <Toggle
              checked={globalMemoryRead}
              disabled={togglingMemory}
              label={t("plusAutoReplyGlobalMemoryRead")}
              onChange={(checked) => {
                if (checked) {
                  setConfirmPolicyMemory(true);
                } else {
                  void applyImmediateToggle(
                    (current) => ({
                      policy: {
                        ...(current.policy ?? DEFAULT_AUTO_REPLY_POLICY),
                        globalMemory: { read: false },
                      },
                    }),
                    setTogglingMemory,
                  );
                }
              }}
            />
          </div>
        </Disclosure>

        <FormActions
          dirty={form.dirty}
          saving={form.status === "saving"}
          justSaved={form.status === "saved"}
          error={form.error}
          onDiscard={form.revert}
          saveLabel={t("save")}
          discardLabel={t("discard")}
          unsavedLabel={t("unsavedChanges")}
          savedLabel={t("saved")}
        />
      </form>

      <RecipientPicker
        open={pickerMode !== null}
        onClose={() => setPickerMode(null)}
        title={pickerMode === "except" ? t("plusAutoReplyAddExcluded") : t("plusAutoReplyAddChat")}
        includeGroups
        selectedIds={pickerMode === "except" ? excludedChats : chats.map((chat) => chat.jid)}
        onPick={(pickedJid) => {
          if (pickerMode === "except") {
            const res = addExcludedChat(excludedChats, pickedJid);
            if (res.added) form.setField("excludedChats", res.excludedChats);
            setPickerMode(null);
          } else if (pickerMode === "only") {
            const fullPolicy: AutoReplyPolicy = {
              ...form.draft.policy,
              globalMemory: { read: false },
            };
            const res = addAutoReplyChat(chats, pickedJid, fullPolicy);
            if (res.added) form.setField("chats", res.chats);
            setPickerMode(null);
          }
        }}
      />

      {editor && (
        <AutoReplyChatEditor
          chat={editor.chat}
          peer={resolvePeer(editor.chat.jid)}
          onClose={() => setEditor(null)}
          onSaved={(updatedChat) => {
            form.setField(
              "chats",
              chats.map((item) => (item.jid === editor.chat.jid ? updatedChat : item)),
            );
            setEditor(null);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) {
            form.setField("chats", removeAutoReplyChat(chats, pendingRemove));
          }
          setPendingRemove(null);
        }}
        title={t("plusAutoReplyRemoveTitle")}
        description={t("plusAutoReplyRemoveBody")}
        confirmLabel={t("plusAutoReplyRemove")}
        cancelLabel={t("cancel")}
      />

      <ConfirmDialog
        isOpen={confirmPolicyMemory}
        onClose={() => setConfirmPolicyMemory(false)}
        onConfirm={() => {
          setConfirmPolicyMemory(false);
          void applyImmediateToggle(
            (current) => ({
              policy: {
                ...(current.policy ?? DEFAULT_AUTO_REPLY_POLICY),
                globalMemory: { read: true },
              },
            }),
            setTogglingMemory,
          );
        }}
        title={t("plusAutoReplyGlobalMemoryConfirmTitle")}
        description={t("plusAutoReplyGlobalMemoryReadWarning")}
        confirmLabel={t("turnOn")}
        cancelLabel={t("cancel")}
        variant="primary"
      />
    </Card>
  );
}
