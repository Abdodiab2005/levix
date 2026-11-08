import type React from "react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { RecipientPicker } from "../../components/RecipientPicker";
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
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
  peerLabel,
  reactionApiCode,
  reactionApiIssues,
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

function errorMessage(t: TFn, err: unknown, fallback: string): string {
  const code = reactionApiCode(err);
  if (code === "REACTION_RULE_INVALID") return t("reactionErrorRuleInvalid");
  if (code === "REACTION_RULE_MISSING") return t("reactionErrorRuleMissing");
  if (code === "REACTION_RULE_CHANGED") return t("reactionErrorRuleChanged");
  if (code === "REACTION_SWITCH_INVALID") return t("reactionErrorSwitchInvalid");
  if (code === "INTERNAL") return t("reactionErrorInternal");
  return err instanceof ApiError && err.message && !reactionApiCode(err) ? err.message : fallback;
}

function issueMessage(t: TFn, field: string, code: string): string {
  const root = field.split(".")[0];
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

function previewText(t: TFn, draft: ReactionDraft): string {
  const vars = {
    role: roleLabel(t, draft.role),
    emoji: draft.emoji.trim() || t("reactionPreviewEmoji"),
    transitions:
      draft.transitions.map((item) => transitionLabel(t, item)).join(t("reactionListJoin")) ||
      t("reactionTransitions"),
    types:
      (draft.action === "stt" ? ["voice" as const] : draft.originalTypes)
        .map((item) => typeLabel(t, item))
        .join(t("reactionListJoin")) || t("reactionTypes"),
    chat: draft.chatName.trim() || t("reactionPreviewChat"),
    action:
      draft.action === "stt" ? t("reactionPreviewActionStt") : t("reactionPreviewActionPing"),
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
  const sourceRef = useRef(rule);
  sourceRef.current = rule;
  const ruleId = rule?.id ?? null;

  const [draft, setDraft] = useState<ReactionDraft>(emptyReactionDraft);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [senderPickerOpen, setSenderPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const source = sourceRef.current;
    if ((source?.id ?? null) !== ruleId) return;
    setDraft(source ? draftFromRule(source) : emptyReactionDraft());
    setChatPickerOpen(false);
    setSenderPickerOpen(false);
    setBusy(false);
    setFormError(null);
    setFieldErrors({});
  }, [open, ruleId]);

  const setField = <K extends keyof ReactionDraft>(key: K, value: ReactionDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    const bucket =
      key === "chatJid" || key === "chatName"
        ? "chatJid"
        : key === "senderIds" || key === "role"
          ? "senders"
          : key === "originalTypes"
            ? "originalTypes"
            : String(key);
    if (fieldErrors[bucket]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[bucket];
        return next;
      });
    }
  };

  const applyIssues = (issues: ReactionIssue[]) => {
    const next: Record<string, string> = {};
    const form: string[] = [];
    for (const issue of issues) {
      const message = issueMessage(t, issue.field, issue.code);
      const bucket = issueBucket(issue.field);
      if (bucket === "form") form.push(message);
      else if (!next[bucket]) next[bucket] = message;
    }
    setFieldErrors(next);
    setFormError(form[0] ?? (issues.length ? t("reactionErrorRuleInvalid") : null));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!draft.chatJid) nextErrors.chatJid = t("reactionChatRequired");
    if (!draft.emoji.trim()) nextErrors.emoji = t("reactionEmojiRequired");
    if (!draft.transitions.length) nextErrors.transitions = t("reactionIssueTransitionsInvalid");
    if (draft.action !== "stt" && !draft.originalTypes.length) {
      nextErrors.originalTypes = t("reactionIssueOriginalTypesInvalid");
    }
    if (draft.senderIds.length > SENDERS_MAX) nextErrors.senders = t("reactionTooManySenders");
    if (
      draft.destination === "owner_private" &&
      !ownerLinked &&
      sourceRef.current?.definition?.destination?.mode !== "owner_private"
    ) {
      nextErrors.destination = t("reactionDestOwnerDisabled");
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFormError(null);
      return;
    }

    const body = draftToWrite({
      ...draft,
      emoji: draft.emoji.trim(),
      priority: clampPriority(draft.priority),
    });
    setBusy(true);
    setFormError(null);
    try {
      const checked = await api.checkReactionRule(body);
      if (checked.issues?.length) {
        applyIssues(checked.issues);
        return;
      }
      const source = sourceRef.current;
      const res = source
        ? await api.updateReactionRule(source.id, { ...body, revision: source.revision })
        : await api.createReactionRule(body);
      onSaved(res.rule, Boolean(source));
    } catch (err) {
      if (reactionApiCode(err) === "REACTION_RULE_CHANGED") {
        onConflict();
        return;
      }
      const issues = reactionApiIssues(err);
      if (issues.length) {
        applyIssues(issues);
        return;
      }
      setFormError(errorMessage(t, err, t("reactionSaveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const addSender = (jid: string) => {
    if (draft.senderIds.includes(jid)) return;
    if (draft.senderIds.length >= SENDERS_MAX) {
      setFieldErrors((prev) => ({ ...prev, senders: t("reactionTooManySenders") }));
      return;
    }
    setField("senderIds", [...draft.senderIds, jid]);
  };

  const typesLocked = draft.action === "stt";
  const shownTypes = typesLocked ? (["voice"] as ReactionOriginalType[]) : draft.originalTypes;
  const emojiHint =
    draft.emoji.trim() && !isReactionEmoji(draft.emoji.trim())
      ? t("reactionEmojiInvalid")
      : t("reactionEmojiHint");

  return (
    <>
      <Dialog
        isOpen={open}
        onClose={onClose}
        title={rule ? t("reactionEditTitle") : t("reactionNewTitle")}
        maxWidth="40rem"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
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
          onSubmit={(event) => void submit(event)}
        >
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <Field label={t("reactionChat")} error={fieldErrors.chatJid}>
            <div className="flex flex-col gap-2">
              {draft.chatJid ? (
                <UserText className="text-sm font-semibold">
                  {draft.chatName || draft.chatJid}
                </UserText>
              ) : null}
              <Button type="button" variant="secondary" onClick={() => setChatPickerOpen(true)}>
                {draft.chatJid ? t("reactionChangeChat") : t("reactionChooseChat")}
              </Button>
            </div>
          </Field>
          <Field
            label={t("reactionEmoji")}
            htmlFor="rx-emoji"
            error={fieldErrors.emoji}
            description={fieldErrors.emoji ? undefined : emojiHint}
          >
            <Input
              id="rx-emoji"
              name="emoji"
              dir="auto"
              value={draft.emoji}
              maxLength={32}
              aria-invalid={fieldErrors.emoji ? true : undefined}
              onChange={(event) => setField("emoji", event.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
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
          <Field label={t("reactionTransitions")} error={fieldErrors.transitions}>
            <div className="flex flex-col">
              {TRANSITIONS.map((value) => (
                <Checkbox
                  key={value}
                  label={transitionLabel(t, value)}
                  checked={draft.transitions.includes(value)}
                  onChange={() => setField("transitions", toggleList(draft.transitions, value))}
                />
              ))}
            </div>
          </Field>
          <Field
            label={t("reactionTypes")}
            error={fieldErrors.originalTypes}
            description={typesLocked ? t("reactionSttVoiceOnly") : undefined}
          >
            <div className="flex flex-col">
              {ORIGINAL_TYPES.map((value) => (
                <Checkbox
                  key={value}
                  label={typeLabel(t, value)}
                  checked={shownTypes.includes(value)}
                  disabled={typesLocked}
                  onChange={() => setField("originalTypes", toggleList(draft.originalTypes, value))}
                />
              ))}
            </div>
          </Field>
          <Field label={t("reactionSendersRole")} htmlFor="rx-role" error={fieldErrors.senders}>
            <Select
              id="rx-role"
              value={draft.role}
              onChange={(event) =>
                setField("role", event.target.value as ReactionDraft["role"])
              }
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
            description={t("reactionSendersIdsHint")}
            error={fieldErrors.senders}
          >
            <div className="flex flex-col gap-3">
              {draft.senderIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draft.senderIds.map((id) => {
                    const label = peerLabel(id, names);
                    return (
                      <Chip
                        key={id}
                        removeLabel={fill(t("reactionRemoveSender"), { name: label })}
                        onRemove={() =>
                          setField(
                            "senderIds",
                            draft.senderIds.filter((item) => item !== id),
                          )
                        }
                      >
                        <UserText>{label}</UserText>
                      </Chip>
                    );
                  })}
                </div>
              )}
              <Button type="button" variant="secondary" onClick={() => setSenderPickerOpen(true)}>
                {t("reactionChooseSenders")}
              </Button>
            </div>
          </Field>
          <Field label={t("reactionAction")} error={fieldErrors.action}>
            <SegmentedControl
              aria-label={t("reactionAction")}
              className="flex w-full flex-wrap"
              value={draft.action}
              onChange={(action) => {
                setDraft((prev) => ({
                  ...prev,
                  action,
                  originalTypes:
                    action === "stt"
                      ? ["voice"]
                      : prev.originalTypes.length === 1 && prev.originalTypes[0] === "voice"
                        ? [...ORIGINAL_TYPES]
                        : prev.originalTypes,
                }));
                if (fieldErrors.action || fieldErrors.originalTypes) {
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.action;
                    delete next.originalTypes;
                    return next;
                  });
                }
              }}
              options={[
                { value: "stt", label: t("reactionActionStt") },
                { value: "ping", label: t("reactionActionPing") },
              ]}
            />
          </Field>
          <Field label={t("reactionDestination")} error={fieldErrors.destination}>
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
          </Field>
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
              onChange={(event) => setField("priority", clampPriority(Number(event.target.value)))}
            />
          </Field>
          <p className="text-sm text-muted">{previewText(t, draft)}</p>
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
          setDraft((prev) => ({ ...prev, chatJid: jid, chatName: names.get(jid) || jid }));
          setFieldErrors((prev) => {
            if (!prev.chatJid) return prev;
            const next = { ...prev };
            delete next.chatJid;
            return next;
          });
          setChatPickerOpen(false);
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
