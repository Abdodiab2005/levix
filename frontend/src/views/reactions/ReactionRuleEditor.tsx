import { userErrorMessage } from "../../utils/userError";
import type React from "react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { RecipientPicker } from "../../components/RecipientPicker";
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  Disclosure,
  Field,
  IconButton,
  Input,
  RadioGroup,
  SegmentedControl,
  Select,
  UserText,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type {
  ReactionIssue,
  ReactionOriginalType,
  ReactionRule,
  ReactionTransition,
} from "../../types";
import { fill } from "../../utils/fill";
import {
  EMOJI_PALETTE,
  ORIGINAL_TYPES,
  SENDERS_MAX,
  SENDER_ROLES,
  TRANSITIONS,
  clampPriority,
  draftFromRule,
  draftToWrite,
  emptyReactionDraft,
  isReactionEmoji,
  issueBucket,
  issueFieldName,
  peerLabel,
  reactionApiCode,
  reactionApiIssues,
  reactionDraftIssues,
  type ReactionDraft,
} from "../../utils/reactionRules";

type TFn = (key: string) => string;

interface ReactionRuleEditorProps {
  open: boolean;
  rule: ReactionRule | null;
  names: ReadonlyMap<string, string>;
  ownerLinked: boolean;
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
  const root = issueFieldName(field).split(".")[0];
  if (code === "owner_unlinked") return t("reactionDestOwnerDisabled");
  if (root === "chatJid" && code === "required") return t("reactionChatRequired");
  if (root === "emoji" && code === "required") return t("reactionEmojiRequired");
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
  if (root === "senders") return t("reactionIssueSendersInvalid");
  if (root === "action") return t("reactionIssueActionInvalid");
  if (root === "destination") return t("reactionIssueDestinationInvalid");
  if (root === "version") return t("reactionIssueVersionInvalid");
  if (root === "body") return t("reactionIssueBodyInvalid");
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

function roleLabel(t: TFn, value: string): string {
  if (value === "any") return t("reactionRoleAny");
  if (value === "owner") return t("reactionRoleOwner");
  if (value === "bot_admin") return t("reactionRoleBotAdmin");
  if (value === "group_admin") return t("reactionRoleGroupAdmin");
  return t("reactionRoleMember");
}

function sectionLabel(t: TFn, field: string): string {
  if (field === "chatJid") return t("reactionChat");
  if (field === "emoji") return t("reactionEmoji");
  if (field === "action") return t("reactionAction");
  if (field === "originalTypes") return t("reactionTypes");
  if (field === "senders") return t("reactionSendersRole");
  if (field === "transitions") return t("reactionTransitions");
  if (field === "destination") return t("reactionDestination");
  return `${t("reactionAdvanced")} (${t("reactionPriority")})`;
}

function previewText(t: TFn, draft: ReactionDraft): string {
  const vars = {
    role: roleLabel(t, draft.role),
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
  ownerLinked,
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

  const [draft, setDraft] = useState<ReactionDraft>(emptyReactionDraft);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [senderPickerOpen, setSenderPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
    setDraft(source ? draftFromRule(source) : emptyReactionDraft());
    setChatPickerOpen(false);
    setSenderPickerOpen(false);
    setBusy(submitPending.current);
    setFormError(null);
    setFieldErrors({});
    return () => {
      submitGen.current += 1;
    };
  }, [open, ruleId]);

  const setField = <K extends keyof ReactionDraft>(
    key: K,
    value: ReactionDraft[K] | ((previous: ReactionDraft[K]) => ReactionDraft[K]),
  ) => {
    setDraft((prev) => ({
      ...prev,
      [key]: typeof value === "function" ? value(prev[key]) : value,
    }));
    setFormError(null);
    const bucket =
      key === "chatJid" || key === "chatName"
        ? "chatJid"
        : key === "senderIds" || key === "role"
          ? "senders"
          : key === "originalTypes"
            ? "originalTypes"
            : String(key);
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[bucket];
      if (key === "action") delete next.originalTypes;
      return next;
    });
  };

  const applyIssues = (issues: ReactionIssue[]) => {
    const next: Record<string, string> = {};
    const form: string[] = [];
    for (const issue of issues) {
      const message = issueMessage(t, issue.field, issue.code);
      const bucket = issueBucket(issue.field);
      if (bucket === "form") form.push(message);
      else next[bucket] = next[bucket] ? `${next[bucket]} ${message}` : message;
    }
    setFieldErrors(next);
    setFormError(form.length ? form.join(" ") : null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitPending.current) return;
    const issues = reactionDraftIssues(draft);
    if (
      draft.destination === "owner_private" &&
      !ownerLinked &&
      frozenSourceRef.current?.definition?.destination?.mode !== "owner_private"
    ) {
      issues.push({ field: "definition.destination", code: "owner_unlinked" });
    }
    applyIssues(issues);
    if (issues.length) return;

    const body = draftToWrite({
      ...draft,
      priority: clampPriority(draft.priority),
    });
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
      const issues = reactionApiIssues(err);
      if (issues.length) {
        applyIssues(issues);
        return;
      }
      setFormError(errorMessage(t, err, "reactionSaveFailed"));
    } finally {
      submitPending.current = false;
      if (openRef.current) setBusy(false);
    }
  };

  const addSender = (jid: string) => {
    if (draft.senderIds.includes(jid)) return;
    if (draft.senderIds.length >= SENDERS_MAX) {
      setFieldErrors((prev) => ({ ...prev, senders: t("reactionTooManySenders") }));
      return;
    }
    setField("senderIds", (previous) => (previous.includes(jid) ? previous : [...previous, jid]));
  };

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
  const allTypes = ORIGINAL_TYPES.every((type) => draft.originalTypes.includes(type));
  const chatLabel = peerLabel(draft.chatJid, names) || draft.chatName || t("reactionPreviewChat");
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
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("reactionCancel")}
            </Button>
            <Button variant="primary" type="submit" form="reaction-rule-form" loading={busy}>
              {t("reactionSave")}
            </Button>
          </>
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
              {draft.chatJid && <UserText className="text-sm font-semibold">{chatLabel}</UserText>}
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
              <fieldset
                id="rx-action"
                className="min-w-0"
                aria-labelledby="rx-action-heading"
                aria-invalid={fieldErrors.action ? true : undefined}
                aria-describedby={describedBy(fieldErrors.action ? "rx-action-message" : undefined)}
              >
                <SegmentedControl<ReactionDraft["action"]>
                  aria-label={t("reactionAction")}
                  className="flex w-full flex-wrap"
                  value={draft.action}
                  onChange={(action) => setField("action", action)}
                  options={[
                    { value: "stt", label: t("reactionActionStt") },
                    { value: "ping", label: t("reactionActionPing") },
                  ]}
                />
              </fieldset>
            </Field>
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
                        setField("originalTypes", event.target.checked ? [...ORIGINAL_TYPES] : [])
                      }
                    />
                  </div>
                  {ORIGINAL_TYPES.map((value) => (
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
            <Field label={t("reactionRole")} htmlFor="rx-role">
              <Select
                id="rx-role"
                value={draft.role}
                aria-invalid={fieldErrors.senders ? true : undefined}
                aria-describedby={describedBy(
                  fieldErrors.senders ? "rx-senders-message" : undefined,
                )}
                onChange={(event) => setField("role", event.target.value as ReactionDraft["role"])}
              >
                {SENDER_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(t, value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t("reactionSendersIds")}
              htmlFor="rx-senders"
              description={t("reactionSendersIdsHint")}
              error={fieldErrors.senders}
            >
              {draft.senderIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draft.senderIds.map((id) => {
                    const label = peerLabel(id, names) || t("reactionUnknownPerson");
                    return (
                      <Chip
                        key={id}
                        removeLabel={fill(t("reactionRemoveSender"), { name: label })}
                        onRemove={() =>
                          setField("senderIds", (previous) =>
                            previous.filter((item) => item !== id),
                          )
                        }
                      >
                        <UserText>{label}</UserText>
                      </Chip>
                    );
                  })}
                </div>
              )}
              <Button
                id="rx-senders"
                type="button"
                variant="secondary"
                aria-invalid={fieldErrors.senders ? true : undefined}
                aria-describedby="rx-senders-message"
                onClick={() => setSenderPickerOpen(true)}
              >
                {t("reactionChooseSenders")}
              </Button>
            </Field>
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
                    checked={draft.transitions.includes(value)}
                    aria-invalid={fieldErrors.transitions ? true : undefined}
                    onChange={() =>
                      setField("transitions", (previous) => toggleList(previous, value))
                    }
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
            {previewText(t, { ...draft, chatName: chatLabel })}
          </UserText>
        </form>
      </Dialog>
      <RecipientPicker
        open={chatPickerOpen}
        onClose={() => setChatPickerOpen(false)}
        title={t("reactionChooseChat")}
        includeGroups
        selectedIds={draft.chatJid ? [draft.chatJid] : []}
        emptyText={t("reactionNoChats")}
        onPick={(jid) => {
          setDraft((prev) => ({ ...prev, chatJid: jid, chatName: peerLabel(jid, names) }));
          setFieldErrors((prev) => {
            if (!prev.chatJid) return prev;
            const next = { ...prev };
            delete next.chatJid;
            return next;
          });
          setChatPickerOpen(false);
          setFormError(null);
        }}
      />
      <RecipientPicker
        open={senderPickerOpen}
        onClose={() => setSenderPickerOpen(false)}
        title={t("reactionChooseSenders")}
        includeGroups={false}
        selectedIds={draft.senderIds}
        emptyText={t("reactionNoContacts")}
        onPick={(jid) => addSender(jid)}
      />
    </>
  );
};
