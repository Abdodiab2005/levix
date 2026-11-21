import { userErrorMessage } from "../../utils/userError";
import { Check, Search } from "lucide-react";
import type React from "react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { RecipientPicker } from "../../components/RecipientPicker";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Chip,
  CodeText,
  Dialog,
  Disclosure,
  Field,
  FormActions,
  IconButton,
  Input,
  RadioGroup,
  type RadioOption,
  Toggle,
  UserText,
  useDirtyForm,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type {
  ReactionCommandField,
  ReactionCommandSpec,
  ReactionIssue,
  ReactionOriginalType,
  ReactionRule,
  ReactionSenderMode,
  ReactionTransition,
} from "../../types";
import { fill } from "../../utils/fill";
import {
  DEFAULT_REACTION_COMMANDS,
  EMOJI_PALETTE,
  ORIGINAL_TYPES,
  SENDERS_MAX,
  TRANSITIONS,
  TRIGGER_MODES,
  buildCommandPickerItems,
  clampPriority,
  classifyReactionCommand,
  commandFieldLabelKey,
  draftFromRule,
  draftToWrite,
  emptyReactionDraft,
  formatCommandToken,
  isRawJid,
  isReactionEmoji,
  issueBucket,
  issueFieldName,
  peerLabel,
  quoteNoteKey,
  reactionApiCode,
  reactionApiIssues,
  reactionDraftIssues,
  resolveSenderMode,
  reuseUnchangedDraftArrays,
  selectReactionCommand,
  selectSenderMode,
  unsupportedReasonKey,
  validateReactionCommandArgs,
  type ReactionDraft,
  type ReactionFieldErrorCode,
} from "../../utils/reactionRules";

type TFn = (key: string) => string;

interface ReactionRuleEditorProps {
  open: boolean;
  rule: ReactionRule | null;
  names: ReadonlyMap<string, string>;
  commands?: readonly ReactionCommandSpec[];
  prefix?: string;
  ownerLinked: boolean;
  onRememberRecipient?: (jid: string, label: string) => void;
  onClose: () => void;
  onSaved: (rule: ReactionRule, edited: boolean) => void;
  onConflict: () => void;
}

function errorMessage(t: TFn, err: unknown, fallbackKey: string): string {
  const code = reactionApiCode(err);
  if (code === "REACTION_RULE_INVALID") return t("reactionErrorRuleInvalid");
  if (code === "REACTION_RULE_MISSING") return t("reactionErrorRuleMissing");
  if (code === "REACTION_RULE_CHANGED") return t("reactionErrorRuleChanged");
  if (code === "REACTION_SWITCH_INVALID") return t("reactionErrorSwitchInvalid");
  if (code === "INTERNAL") return t("reactionErrorInternal");
  return userErrorMessage(t, err, fallbackKey);
}

function issueMessage(t: TFn, field: string, code: string): string {
  const name = issueFieldName(field);
  const root = name.split(".")[0];
  if (code === "owner_unlinked") return t("reactionDestOwnerDisabled");
  if (root === "chatJid" && code === "required") return t("reactionChatRequired");
  if (root === "emoji" && code === "required") return t("reactionEmojiRequired");
  if (root === "senders" && code === "required") return t("reactionSendersRequired");
  if (name === "command.args" && code === "required") return t("reactionArgRequired");
  if (name === "command.name" && code && code !== "invalid") {
    return t(unsupportedReasonKey(code));
  }
  if (code === "add_only") return t("reactionIssueTransitionsAddOnly");
  if (code === "voice_only") return t("reactionIssueVoiceOnly");
  if (code === "too_many") {
    if (root === "senders") return t("reactionIssueSendersTooMany");
    return t("reactionIssueTooMany");
  }
  if (code === "duplicate") {
    if (root === "senders") return t("reactionIssueSendersDuplicate");
    return t("reactionIssueDuplicate");
  }
  if (code === "unknown_field") return t("reactionIssueUnknownField");
  if (root === "chatJid") return t("reactionIssueChatJidInvalid");
  if (root === "priority") return t("reactionIssuePriorityInvalid");
  if (root === "emoji") return t("reactionIssueEmojiInvalid");
  if (root === "transitions") return t("reactionIssueTransitionsInvalid");
  if (root === "originalTypes") return t("reactionIssueOriginalTypesInvalid");
  if (root === "senders" || root === "allowOthersOnLinkedMessages")
    return t("reactionIssueSendersInvalid");
  if (name === "command.args") return t("reactionIssueInvalid");
  if (root === "action" || root === "command") return t("reactionIssueActionInvalid");
  if (root === "destination") return t("reactionIssueDestinationInvalid");
  if (root === "version") return t("reactionIssueVersionInvalid");
  if (root === "body") return t("reactionIssueBodyInvalid");
  return t("reactionIssueInvalid");
}

function argFieldErrorMessage(
  t: TFn,
  field: ReactionCommandField,
  code: ReactionFieldErrorCode | undefined,
): string | undefined {
  if (!code) return undefined;
  if (code === "required") return t("reactionArgRequired");
  if (code === "too_long") return fill(t("reactionArgTooLong"), { max: field.maxLength });
  if (code === "multiline") return t("reactionArgMultiline");
  if (code === "reserved") return t("reactionArgGeminiReserved");
  if (code === "pattern") {
    if (field.id === "keyword") return t("reactionArgKeywordPattern");
    if (field.id === "status") return t("reactionArgStatusPattern");
  }
  return t("reactionIssueInvalid");
}

function transitionLabel(t: TFn, value: ReactionTransition): string {
  if (value === "add") return t("reactionTransitionAdd");
  if (value === "change") return t("reactionTransitionChange");
  return t("reactionTransitionRemove");
}

function typeLabel(t: TFn, value: ReactionOriginalType): string {
  if (value === "text") return t("reactionTypeText");
  if (value === "voice") return t("reactionTypeVoice");
  if (value === "audio") return t("reactionTypeAudio");
  if (value === "image") return t("reactionTypeImage");
  if (value === "video") return t("reactionTypeVideo");
  if (value === "document") return t("reactionTypeDocument");
  return t("reactionTypeSticker");
}

function senderModeLabel(t: TFn, mode: ReactionSenderMode): string {
  switch (mode) {
    case "any":
      return t("reactionRoleEveryone");
    case "owner_group_admin":
      return t("reactionRoleOwnerGroupAdmin");
    case "owner":
      return t("reactionRoleOwnerOnly");
    case "group_admin":
      return t("reactionRoleGroupAdminOnly");
    case "selected":
      return t("reactionRoleSelected");
    case "custom":
      return t("reactionRoleCustom");
  }
}

function sectionLabel(t: TFn, field: string): string {
  if (field === "chatJid") return t("reactionChat");
  if (field === "emoji") return t("reactionEmoji");
  if (field === "action") return t("reactionAction");
  if (field === "args") return t("reactionCommandArgs");
  if (field === "originalTypes") return t("reactionTypes");
  if (field === "senders") return t("reactionSendersRole");
  if (field === "transitions") return t("reactionTransitions");
  if (field === "destination") return t("reactionDestination");
  return `${t("reactionAdvanced")} (${t("reactionPriority")})`;
}

function previewText(t: TFn, draft: ReactionDraft, prefix: string): string {
  const mode = resolveSenderMode(draft);
  const commandToken = formatCommandToken(draft.action, prefix);
  const vars = {
    role: senderModeLabel(t, mode),
    emoji: draft.emoji || t("reactionPreviewEmoji"),
    transitions:
      draft.transitions.map((item) => transitionLabel(t, item)).join(t("reactionListJoin")) ||
      t("reactionTransitions"),
    types:
      draft.action !== "stt" && ORIGINAL_TYPES.every((type) => draft.originalTypes.includes(type))
        ? t("reactionPreviewAllTypes")
        : (draft.action === "stt" ? ["voice" as const] : draft.originalTypes)
            .map((item) => typeLabel(t, item))
            .join(t("reactionListJoin")) || t("reactionTypes"),
    chat: draft.chatName.trim() || t("reactionPreviewChat"),
    action:
      draft.action === "stt"
        ? t("reactionPreviewActionStt")
        : draft.action === "ping"
          ? t("reactionPreviewActionPing")
          : commandToken
            ? fill(t("reactionPreviewActionCommand"), { command: commandToken })
            : t("reactionPreviewActionUnset"),
    destination:
      draft.destination === "owner_private" ? t("reactionDestOwner") : t("reactionDestSame"),
    n: draft.senderIds.length,
  };
  return fill(
    draft.senderIds.length > 0 ? t("reactionPreviewWithPeople") : t("reactionPreview"),
    vars,
  );
}

function toggleList<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function describedBy(...ids: Array<string | undefined>): string | undefined {
  const next = ids.filter((id): id is string => Boolean(id));
  return next.length ? next.join(" ") : undefined;
}

export const ReactionRuleEditor: React.FC<ReactionRuleEditorProps> = ({
  open,
  rule,
  names,
  commands = DEFAULT_REACTION_COMMANDS,
  prefix = "!",
  ownerLinked,
  onRememberRecipient,
  onClose,
  onSaved,
  onConflict,
}) => {
  const { t: tKey } = useI18n();
  const t = tKey as TFn;
  const ruleId = rule?.id ?? null;
  const openRef = useRef(open);
  openRef.current = open;
  const latestRuleRef = useRef(rule);
  latestRuleRef.current = rule;
  const frozenSourceRef = useRef<ReactionRule | null>(null);
  const submitGen = useRef(0);
  const submitPending = useRef(false);

  const [initialDraft, setInitialDraft] = useState<ReactionDraft>(emptyReactionDraft);
  const form = useDirtyForm<ReactionDraft>(
    initialDraft,
    "reactionSaveFailed",
    (t, err, fallbackKey) => errorMessage(t as unknown as TFn, err, fallbackKey),
  );
  const { draft } = form;

  const [commandQuery, setCommandQuery] = useState("");
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [senderPickerOpen, setSenderPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pickedNames, setPickedNames] = useState<ReadonlyMap<string, string>>(() => new Map());

  const mergedNames = useMemo(() => {
    if (pickedNames.size === 0) return names;
    const map = new Map(names);
    for (const [k, v] of pickedNames) {
      if (v && !isRawJid(v)) map.set(k, v);
    }
    return map;
  }, [names, pickedNames]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ruleId re-freezes the target when the editor switches rules.
  useEffect(() => {
    if (!open) {
      submitGen.current += 1;
      frozenSourceRef.current = null;
      return;
    }
    // Freeze id+revision at open / target change; polling must not refresh them.
    submitGen.current += 1;
    const source = latestRuleRef.current ?? null;
    frozenSourceRef.current = source;
    const base = source ? draftFromRule(source, commands) : emptyReactionDraft();
    setInitialDraft(base);
    form.setDraft(base);
    setCommandQuery("");
    setChatPickerOpen(false);
    setSenderPickerOpen(false);
    setBusy(submitPending.current);
    setFormError(null);
    setFieldErrors({});
    return () => {
      submitGen.current += 1;
    };
  }, [open, ruleId]);

  const updateDraft = (updater: (previous: ReactionDraft) => ReactionDraft) => {
    form.setDraft((prev) => reuseUnchangedDraftArrays(updater(prev), initialDraft));
    setFormError(null);
  };

  const clearBuckets = (...buckets: string[]) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const bucket of buckets) delete next[bucket];
      return next;
    });
  };

  const setField = <K extends keyof ReactionDraft>(
    key: K,
    value: ReactionDraft[K] | ((previous: ReactionDraft[K]) => ReactionDraft[K]),
  ) => {
    updateDraft((prev) => ({
      ...prev,
      [key]: typeof value === "function" ? value(prev[key]) : value,
    }));
    const bucket =
      key === "chatJid" || key === "chatName"
        ? "chatJid"
        : key === "senderIds" ||
            key === "role" ||
            key === "senderMode" ||
            key === "allowOthersOnLinkedMessages"
          ? "senders"
          : key === "originalTypes"
            ? "originalTypes"
            : key === "commandArgs"
              ? "args"
              : String(key);
    clearBuckets(bucket, ...(key === "action" ? ["originalTypes", "args", "transitions"] : []));
  };

  const handlePickCommand = (commandKey: string) => {
    const spec = classifyReactionCommand(commandKey, commands);
    if (spec.mode === "unsupported") return;
    updateDraft((prev) => selectReactionCommand(prev, commandKey, commands));
    clearBuckets("action", "args", "originalTypes", "transitions");
  };

  const handleSelectSenderMode = (mode: ReactionSenderMode) => {
    updateDraft((prev) => selectSenderMode(prev, mode));
    clearBuckets("senders");
  };

  const setCommandArg = (index: number, value: string) => {
    updateDraft((prev) => {
      const nextArgs = [...prev.commandArgs];
      while (nextArgs.length <= index) nextArgs.push("");
      nextArgs[index] = value;
      return { ...prev, commandArgs: nextArgs };
    });
    clearBuckets("args", "action");
  };

  const applyIssues = (issues: ReactionIssue[]) => {
    const next: Record<string, string> = {};
    const formMessages: string[] = [];
    for (const issue of issues) {
      const message = issueMessage(t, issue.field, issue.code);
      const bucket = issueBucket(issue.field);
      if (bucket === "form") formMessages.push(message);
      else next[bucket] = next[bucket] ? `${next[bucket]} ${message}` : message;
    }
    setFieldErrors(next);
    setFormError(formMessages.length ? formMessages.join(" ") : null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitPending.current) return;
    const issues = reactionDraftIssues(draft, commands);
    if (
      draft.destination === "owner_private" &&
      !ownerLinked &&
      frozenSourceRef.current?.definition?.destination?.mode !== "owner_private"
    ) {
      issues.push({ field: "definition.destination", code: "owner_unlinked" });
    }
    applyIssues(issues);
    if (issues.length) return;

    const body = draftToWrite(
      {
        ...draft,
        priority: clampPriority(draft.priority),
      },
      commands,
    );
    const token = ++submitGen.current;
    const target = frozenSourceRef.current;
    const targetId = target?.id ?? null;
    const targetRevision = target?.revision;
    const stale = () =>
      token !== submitGen.current ||
      !openRef.current ||
      (frozenSourceRef.current?.id ?? null) !== targetId;
    submitPending.current = true;
    setBusy(true);
    setFormError(null);
    try {
      const checked = await api.checkReactionRule(body);
      if (stale()) return;
      if (checked.issues?.length) {
        applyIssues(checked.issues);
        return;
      }
      const res = targetId
        ? await api.updateReactionRule(targetId, { ...body, revision: targetRevision as string })
        : await api.createReactionRule(body);
      if (stale()) return;
      if (!res.rule) {
        setFormError(t("reactionSaveFailed"));
        return;
      }
      onSaved(res.rule, Boolean(targetId));
    } catch (err) {
      if (stale()) return;
      if (reactionApiCode(err) === "REACTION_RULE_CHANGED") {
        setFormError(t("reactionEditConflict"));
        onConflict();
        return;
      }
      const apiIssues = reactionApiIssues(err);
      if (apiIssues.length) {
        applyIssues(apiIssues);
        return;
      }
      setFormError(errorMessage(t, err, "reactionSaveFailed"));
    } finally {
      submitPending.current = false;
      if (openRef.current) setBusy(false);
    }
  };

  const rememberName = (jid: string, displayTitle?: string) => {
    if (!jid || !displayTitle || isRawJid(displayTitle)) return;
    setPickedNames((prev) => {
      if (prev.get(jid) === displayTitle) return prev;
      const next = new Map(prev);
      next.set(jid, displayTitle);
      return next;
    });
    onRememberRecipient?.(jid, displayTitle);
  };

  const addSender = (jid: string, displayTitle?: string) => {
    rememberName(jid, displayTitle);
    if (draft.senderIds.includes(jid)) return;
    if (draft.senderIds.length >= SENDERS_MAX) {
      setFieldErrors((prev) => ({ ...prev, senders: t("reactionTooManySenders") }));
      return;
    }
    setField("senderIds", (previous) => (previous.includes(jid) ? previous : [...previous, jid]));
  };

  const removeSender = (jid: string) => {
    setField("senderIds", (previous) => previous.filter((item) => item !== jid));
  };

  const discardChanges = () => {
    if (submitPending.current) return;
    form.revert();
    setFormError(null);
    setFieldErrors({});
  };

  const selectedSpec = useMemo(
    () => (draft.action ? classifyReactionCommand(draft.action, commands) : null),
    [draft.action, commands],
  );

  const pickerItems = useMemo(
    () => buildCommandPickerItems(commands, commandQuery, prefix),
    [commands, commandQuery, prefix],
  );

  const allowedOriginalTypes: readonly ReactionOriginalType[] = useMemo(() => {
    if (selectedSpec && selectedSpec.mode !== "unsupported" && selectedSpec.originalTypes.length) {
      return selectedSpec.originalTypes;
    }
    return ORIGINAL_TYPES;
  }, [selectedSpec]);

  const liveArgValidation = useMemo(() => {
    if (!selectedSpec || selectedSpec.mode !== "args") return null;
    return validateReactionCommandArgs(draft.action, draft.commandArgs, commands);
  }, [selectedSpec, draft.action, draft.commandArgs, commands]);

  const activeSenderMode = resolveSenderMode(draft);
  const senderOptions: RadioOption<ReactionSenderMode>[] = useMemo(() => {
    const base: RadioOption<ReactionSenderMode>[] = TRIGGER_MODES.map((mode) => ({
      value: mode,
      label: senderModeLabel(t, mode),
    }));
    if (activeSenderMode === "custom") {
      base.push({
        value: "custom",
        label: t("reactionRoleCustom"),
      });
    }
    return base;
  }, [activeSenderMode, t]);

  const quoteNote = quoteNoteKey(selectedSpec);
  const isDestructive = selectedSpec?.destructive === true;

  const emojiError =
    draft.emoji && !isReactionEmoji(draft.emoji) ? t("reactionEmojiInvalid") : fieldErrors.emoji;
  const errors = { ...fieldErrors, ...(emojiError ? { emoji: emojiError } : {}) };
  const invalidSections = Object.keys(errors).map((field) => sectionLabel(t, field));
  const errorBanner = [
    formError,
    invalidSections.length
      ? fill(t("reactionFixSections"), { sections: invalidSections.join(t("reactionListJoin")) })
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const allTypes = allowedOriginalTypes.every((type) => draft.originalTypes.includes(type));
  const resolvedChatName =
    peerLabel(draft.chatJid, mergedNames) ||
    (!isRawJid(draft.chatName) ? draft.chatName : "") ||
    (draft.chatJid
      ? draft.chatJid.endsWith("@g.us")
        ? t("recipientUnnamedGroup")
        : t("recipientUnknownContact")
      : t("reactionPreviewChat"));
  const close = () => {
    if (!submitPending.current) onClose();
  };

  return (
    <>
      <Dialog
        isOpen={open}
        onClose={close}
        title={rule ? t("reactionEditTitle") : t("reactionNewTitle")}
        variant="mobileFullscreen"
        maxWidth="40rem"
        footer={
          <Button variant="secondary" onClick={close} disabled={busy}>
            {t("reactionCancel")}
          </Button>
        }
      >
        <form
          id="reaction-rule-form"
          className="flex flex-col gap-4"
          aria-busy={busy}
          onSubmit={(event) => void submit(event)}
        >
          {errorBanner && (
            <p role="alert" className="text-sm text-danger">
              {errorBanner}
            </p>
          )}
          <section className="flex flex-col gap-2" aria-labelledby="rx-chat-heading">
            <h3 id="rx-chat-heading" className="text-sm font-bold text-text-main">
              1. {t("reactionChat")}
            </h3>
            <Field htmlFor="rx-chat" error={fieldErrors.chatJid}>
              {draft.chatJid && (
                <UserText className="text-sm font-semibold">{resolvedChatName}</UserText>
              )}
              <Button
                id="rx-chat"
                type="button"
                variant="secondary"
                aria-invalid={fieldErrors.chatJid ? true : undefined}
                aria-describedby={describedBy(fieldErrors.chatJid ? "rx-chat-message" : undefined)}
                onClick={() => setChatPickerOpen(true)}
              >
                {draft.chatJid ? t("reactionChangeChat") : t("reactionChooseChat")}
              </Button>
            </Field>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-emoji-heading">
            <h3 id="rx-emoji-heading" className="text-sm font-bold text-text-main">
              2. {t("reactionEmoji")}
            </h3>
            <Field htmlFor="rx-emoji" error={emojiError} description={t("reactionEmojiHint")}>
              <div className="flex items-center gap-3">
                {isReactionEmoji(draft.emoji) && (
                  <span className="text-4xl leading-none" aria-hidden>
                    <UserText>{draft.emoji}</UserText>
                  </span>
                )}
                <Input
                  id="rx-emoji"
                  name="emoji"
                  dir="auto"
                  value={draft.emoji}
                  aria-labelledby="rx-emoji-heading"
                  aria-invalid={emojiError ? true : undefined}
                  aria-describedby="rx-emoji-message"
                  onChange={(event) => setField("emoji", event.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EMOJI_PALETTE.map((emoji) => (
                  <IconButton
                    key={emoji}
                    label={fill(t("reactionPickEmoji"), { emoji })}
                    pressed={draft.emoji === emoji}
                    icon={<span className="text-lg leading-none">{emoji}</span>}
                    onClick={() => setField("emoji", emoji)}
                  />
                ))}
              </div>
            </Field>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-action-heading">
            <h3 id="rx-action-heading" className="text-sm font-bold text-text-main">
              3. {t("reactionAction")}
            </h3>
            <Field htmlFor="rx-action" error={fieldErrors.action}>
              <div className="relative">
                <Search
                  size={16}
                  className="pointer-events-none absolute start-3 top-3 text-muted"
                />
                <Input
                  id="rx-command-search"
                  type="search"
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  placeholder={t("reactionCommandSearch")}
                  aria-label={t("reactionCommandSearch")}
                  className="ps-9"
                />
              </div>
              <fieldset
                id="rx-action"
                className="min-w-0"
                aria-labelledby="rx-action-heading"
                aria-invalid={fieldErrors.action ? true : undefined}
                aria-describedby={describedBy(fieldErrors.action ? "rx-action-message" : undefined)}
              >
                {pickerItems.length === 0 ? (
                  <p className="py-2 text-xs text-muted">{t("reactionCommandNoResults")}</p>
                ) : (
                  <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-xl border border-line bg-panel-raised/40 p-2">
                    {pickerItems.map((item) => {
                      const itemId = item.key;
                      const selected = draft.action === itemId;
                      return (
                        <Button
                          key={itemId}
                          type="button"
                          variant="secondary"
                          disabled={item.disabled}
                          aria-pressed={selected}
                          onClick={() => handlePickCommand(itemId)}
                          className={`h-auto min-h-11 w-full items-start justify-between gap-2 px-3 py-2 text-start ${
                            selected ? "border-brand-blue/50 bg-brand-blue/10" : ""
                          }`}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-2">
                              <CodeText className="text-xs font-bold text-brand-cyan">
                                {item.token}
                              </CodeText>
                              {item.reasonKey && <Badge tone="neutral">{t(item.reasonKey)}</Badge>}
                            </span>
                            {item.description && (
                              <UserText lines={2} className="text-xs text-muted">
                                {item.description}
                              </UserText>
                            )}
                          </span>
                          {selected && (
                            <span className="inline-flex shrink-0 items-center pt-0.5 text-brand-blue">
                              <Check size={16} aria-hidden />
                            </span>
                          )}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            </Field>

            {quoteNote && <p className="text-xs text-muted">{t(quoteNote)}</p>}

            {isDestructive && (
              <Callout tone="warn" title={t("reactionDestructiveTitle")}>
                {t("reactionDestructiveWarning")}
              </Callout>
            )}

            {selectedSpec?.mode === "args" && selectedSpec.fields.length > 0 && (
              <div className="flex flex-col gap-2">
                {selectedSpec.fields.map((field, index) => {
                  const val = draft.commandArgs[index] ?? "";
                  const liveCode = liveArgValidation?.fieldErrors[field.id];
                  const showInline = val.length > 0 || Boolean(fieldErrors.args);
                  const inlineErr = showInline
                    ? (argFieldErrorMessage(t, field, liveCode) ?? fieldErrors.args)
                    : undefined;
                  const inputId = `rx-arg-${field.id}`;
                  return (
                    <Field
                      key={field.id}
                      label={t(commandFieldLabelKey(field.id))}
                      htmlFor={inputId}
                      error={inlineErr}
                      description={fill(t("reactionArgCharLimit"), {
                        n: val.length,
                        max: field.maxLength,
                      })}
                    >
                      <Input
                        id={inputId}
                        value={val}
                        maxLength={field.maxLength}
                        required={field.required}
                        technical={field.id === "keyword" || field.id === "status"}
                        aria-invalid={inlineErr ? true : undefined}
                        aria-describedby={`${inputId}-message`}
                        onChange={(event) => setCommandArg(index, event.target.value)}
                      />
                    </Field>
                  );
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-types-heading">
            <h3 id="rx-types-heading" className="text-sm font-bold text-text-main">
              4. {t("reactionTypes")}
            </h3>
            <Field htmlFor="rx-types" error={fieldErrors.originalTypes}>
              {draft.action === "stt" ? (
                <p id="rx-types" className="text-sm text-muted">
                  {t("reactionSttVoiceOnly")}
                </p>
              ) : allowedOriginalTypes.length === 1 && allowedOriginalTypes[0] === "sticker" ? (
                <p id="rx-types" className="text-sm text-muted">
                  {t("reactionToimageStickerOnly")}
                </p>
              ) : (
                <fieldset
                  id="rx-types"
                  className="grid min-w-0 grid-cols-2 gap-x-3"
                  aria-labelledby="rx-types-heading"
                  aria-describedby={describedBy(
                    fieldErrors.originalTypes ? "rx-types-message" : undefined,
                  )}
                >
                  <div className="col-span-2">
                    <Checkbox
                      label={t("reactionAllTypes")}
                      checked={allTypes}
                      ref={(input) => {
                        if (input)
                          input.indeterminate = !allTypes && draft.originalTypes.length > 0;
                      }}
                      aria-invalid={fieldErrors.originalTypes ? true : undefined}
                      onChange={(event) =>
                        setField(
                          "originalTypes",
                          event.target.checked ? [...allowedOriginalTypes] : [],
                        )
                      }
                    />
                  </div>
                  {allowedOriginalTypes.map((value) => (
                    <Checkbox
                      key={value}
                      label={typeLabel(t, value)}
                      checked={draft.originalTypes.includes(value)}
                      aria-invalid={fieldErrors.originalTypes ? true : undefined}
                      aria-describedby={describedBy(
                        fieldErrors.originalTypes ? "rx-types-message" : undefined,
                      )}
                      onChange={() =>
                        setField("originalTypes", (previous) => toggleList(previous, value))
                      }
                    />
                  ))}
                </fieldset>
              )}
            </Field>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-senders-heading">
            <h3 id="rx-senders-heading" className="text-sm font-bold text-text-main">
              5. {t("reactionSendersRole")}
            </h3>
            <Field
              htmlFor="rx-role"
              description={t("reactionSendersPermissionHint")}
              error={fieldErrors.senders}
            >
              <fieldset
                id="rx-role"
                className="min-w-0"
                aria-labelledby="rx-senders-heading"
                aria-invalid={fieldErrors.senders ? true : undefined}
                aria-describedby={describedBy(fieldErrors.senders ? "rx-role-message" : undefined)}
              >
                <RadioGroup
                  name="rx-role"
                  value={activeSenderMode}
                  onChange={handleSelectSenderMode}
                  options={senderOptions}
                />
              </fieldset>

              {(activeSenderMode === "selected" ||
                (activeSenderMode === "custom" && draft.senderIds.length > 0)) && (
                <div className="flex flex-col gap-2 pt-1">
                  {draft.senderIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {draft.senderIds.map((id) => {
                        const label = peerLabel(id, mergedNames) || t("reactionUnknownPerson");
                        return (
                          <Chip
                            key={id}
                            removeLabel={fill(t("reactionRemoveSender"), { name: label })}
                            onRemove={
                              activeSenderMode === "selected" ? () => removeSender(id) : undefined
                            }
                          >
                            <UserText>{label}</UserText>
                          </Chip>
                        );
                      })}
                    </div>
                  )}
                  {activeSenderMode === "selected" && (
                    <Button
                      id="rx-senders"
                      type="button"
                      variant="secondary"
                      aria-invalid={fieldErrors.senders ? true : undefined}
                      aria-describedby="rx-role-message"
                      onClick={() => setSenderPickerOpen(true)}
                    >
                      {t("reactionChooseSenders")}
                    </Button>
                  )}
                </div>
              )}
            </Field>

            <Toggle
              id="rx-allow-others-linked"
              checked={draft.allowOthersOnLinkedMessages}
              onChange={(checked) => setField("allowOthersOnLinkedMessages", checked)}
              label={t("reactionAllowOthersOnLinked")}
              description={t("reactionAllowOthersOnLinkedHint")}
            />
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-transitions-heading">
            <h3 id="rx-transitions-heading" className="text-sm font-bold text-text-main">
              6. {t("reactionTransitions")}
            </h3>
            <Field htmlFor="rx-transitions" error={fieldErrors.transitions}>
              <fieldset
                id="rx-transitions"
                className="flex min-w-0 flex-col"
                aria-labelledby="rx-transitions-heading"
                aria-describedby={describedBy(
                  fieldErrors.transitions ? "rx-transitions-message" : undefined,
                )}
              >
                {TRANSITIONS.map((value) => (
                  <Checkbox
                    key={value}
                    label={transitionLabel(t, value)}
                    checked={isDestructive ? value === "add" : draft.transitions.includes(value)}
                    disabled={isDestructive}
                    aria-invalid={fieldErrors.transitions ? true : undefined}
                    onChange={() => {
                      if (isDestructive) return;
                      setField("transitions", (previous) => toggleList(previous, value));
                    }}
                  />
                ))}
              </fieldset>
            </Field>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rx-destination-heading">
            <h3 id="rx-destination-heading" className="text-sm font-bold text-text-main">
              7. {t("reactionDestination")}
            </h3>
            <Field htmlFor="rx-destination" error={fieldErrors.destination}>
              <fieldset
                id="rx-destination"
                className="min-w-0"
                aria-labelledby="rx-destination-heading"
                aria-invalid={fieldErrors.destination ? true : undefined}
                aria-describedby={describedBy(
                  fieldErrors.destination ? "rx-destination-message" : undefined,
                )}
              >
                <RadioGroup
                  name="rx-destination"
                  value={draft.destination}
                  onChange={(mode) => {
                    if (mode === "owner_private" && !ownerLinked) return;
                    setField("destination", mode);
                  }}
                  options={[
                    { value: "same_chat", label: t("reactionDestSame") },
                    {
                      value: "owner_private",
                      label: t("reactionDestOwner"),
                      description: ownerLinked ? undefined : t("reactionDestOwnerDisabled"),
                    },
                  ]}
                />
              </fieldset>
            </Field>
          </section>

          <Disclosure
            key={`${open}-${ruleId}`}
            summary={
              <span className="flex flex-col gap-1">
                <span>8. {t("reactionAdvanced")}</span>
                {fieldErrors.priority && (
                  <span className="text-xs text-danger">{fieldErrors.priority}</span>
                )}
              </span>
            }
          >
            <Field
              label={t("reactionPriority")}
              htmlFor="rx-priority"
              error={fieldErrors.priority}
              description={t("reactionPriorityHint")}
            >
              <Input
                id="rx-priority"
                name="priority"
                type="number"
                min={0}
                max={1000}
                step={1}
                technical
                value={Number.isFinite(draft.priority) ? draft.priority : 100}
                aria-invalid={fieldErrors.priority ? true : undefined}
                aria-describedby="rx-priority-message"
                onChange={(event) =>
                  setField("priority", clampPriority(Number(event.target.value)))
                }
              />
            </Field>
          </Disclosure>

          <UserText as="p" className="text-sm text-muted">
            {previewText(t, { ...draft, chatName: resolvedChatName }, prefix)}
          </UserText>

          <FormActions
            dirty={form.dirty}
            saving={busy || form.status === "saving"}
            justSaved={form.status === "saved"}
            error={errorBanner || form.error}
            onDiscard={discardChanges}
            saveLabel={t("reactionSave")}
            discardLabel={t("discard")}
            unsavedLabel={t("unsavedChanges")}
            savedLabel={t("saved")}
          />
        </form>
      </Dialog>

      <RecipientPicker
        open={chatPickerOpen}
        onClose={() => setChatPickerOpen(false)}
        title={t("reactionChooseChat")}
        includeGroups
        selectedIds={draft.chatJid ? [draft.chatJid] : []}
        emptyText={t("reactionNoChats")}
        onPick={(jid, _item, displayTitle) => {
          rememberName(jid, displayTitle);
          const cleanTitle =
            displayTitle && !isRawJid(displayTitle) ? displayTitle : peerLabel(jid, mergedNames);
          updateDraft((prev) => ({
            ...prev,
            chatJid: jid,
            chatName: cleanTitle,
          }));
          clearBuckets("chatJid");
          setChatPickerOpen(false);
        }}
      />

      <RecipientPicker
        open={senderPickerOpen}
        onClose={() => setSenderPickerOpen(false)}
        title={t("reactionChooseSenders")}
        includeGroups={false}
        multiSelect
        selectedIds={draft.senderIds}
        emptyText={t("reactionNoContacts")}
        onPick={(jid, _item, displayTitle) => addSender(jid, displayTitle)}
        onToggle={(jid) => removeSender(jid)}
      />
    </>
  );
};
