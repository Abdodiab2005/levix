// file: frontend/src/views/plus/AutoReplyChatEditor.tsx
import { User, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { BidiText } from "../../components/RecipientPicker";
import {
  Button,
  ChipInput,
  type ChipRejectReason,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  ListRow,
  Select,
  Textarea,
  Toggle,
  UserText,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import type { RecipientParts } from "../../utils/recipientLabel";
import { type AutoReplyChat, type AutoReplyTrigger, PLUS_LIMITS } from "./types";

const TRIGGERS: AutoReplyTrigger[] = ["all", "mention", "keywords"];

function readInteger(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function AutoReplyChatEditor({
  onClose,
  onSaved,
  chat,
  peer,
}: {
  onClose: () => void;
  onSaved: (chat: AutoReplyChat) => void;
  chat: AutoReplyChat;
  peer: RecipientParts;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(chat.enabled);
  const [trigger, setTrigger] = useState<AutoReplyTrigger>(chat.trigger);
  const [keywords, setKeywords] = useState<string[]>(chat.keywords);
  const [instructions, setInstructions] = useState(chat.instructions);
  const [cooldown, setCooldown] = useState(String(chat.cooldownSeconds));
  const [perSender, setPerSender] = useState(String(chat.perSenderPerHour));
  const [perChat, setPerChat] = useState(String(chat.perChatPerHour));
  const [globalMemoryRead, setGlobalMemoryRead] = useState(chat.globalMemory?.read ?? false);
  const [confirmMemory, setConfirmMemory] = useState(false);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [cooldownError, setCooldownError] = useState<string | null>(null);
  const [perSenderError, setPerSenderError] = useState<string | null>(null);
  const [perChatError, setPerChatError] = useState<string | null>(null);

  const range = (min: number, max: number) => fill(t("plusAutoReplyRange"), { min, max });
  const triggerLabel = (value: AutoReplyTrigger) =>
    value === "mention"
      ? t("plusTriggerMention")
      : value === "keywords"
        ? t("plusTriggerKeywords")
        : t("plusTriggerAll");

  function rejectKeyword(reason: ChipRejectReason | null) {
    if (reason === "long") setKeywordError(t("plusAutoReplyKeywordTooLong"));
    else if (reason === "max") setKeywordError(t("plusAutoReplyKeywordMax"));
    else if (reason === "duplicate") setKeywordError(t("plusAutoReplyKeywordDuplicate"));
    else setKeywordError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const cooldownValue = readInteger(cooldown);
    const cooldownProblem =
      Number.isInteger(cooldownValue) &&
      cooldownValue >= PLUS_LIMITS.cooldownSeconds.min &&
      cooldownValue <= PLUS_LIMITS.cooldownSeconds.max
        ? null
        : range(PLUS_LIMITS.cooldownSeconds.min, PLUS_LIMITS.cooldownSeconds.max);
    const senderValue = readInteger(perSender);
    const senderProblem =
      Number.isInteger(senderValue) &&
      senderValue >= PLUS_LIMITS.perSenderPerHour.min &&
      senderValue <= PLUS_LIMITS.perSenderPerHour.max
        ? null
        : range(PLUS_LIMITS.perSenderPerHour.min, PLUS_LIMITS.perSenderPerHour.max);
    const chatValue = readInteger(perChat);
    const chatProblem =
      Number.isInteger(chatValue) &&
      chatValue >= PLUS_LIMITS.perChatPerHour.min &&
      chatValue <= PLUS_LIMITS.perChatPerHour.max
        ? null
        : range(PLUS_LIMITS.perChatPerHour.min, PLUS_LIMITS.perChatPerHour.max);

    setCooldownError(cooldownProblem);
    setPerSenderError(senderProblem);
    setPerChatError(chatProblem);
    if (cooldownProblem || senderProblem || chatProblem) return;

    onSaved({
      jid: chat.jid,
      enabled,
      trigger,
      keywords,
      instructions: instructions.trim(),
      cooldownSeconds: cooldownValue,
      perSenderPerHour: senderValue,
      perChatPerHour: chatValue,
      globalMemory: { read: globalMemoryRead },
    });
  }

  return (
    <>
      <Dialog
        isOpen
        onClose={onClose}
        title={t("plusAutoReplyEditChat")}
        variant="mobileFullscreen"
        maxWidth="36rem"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" type="submit" form="plus-auto-reply-chat">
              {t("plusAutoReplyApply")}
            </Button>
          </>
        }
      >
        <form
          id="plus-auto-reply-chat"
          className="flex flex-col gap-4"
          onSubmit={(event) => submit(event)}
        >
          <ListRow
            variant="raised"
            leading={
              peer.kind === "group" ? (
                <Users size={16} className="text-brand-cyan" />
              ) : (
                <User size={16} className="text-ok" />
              )
            }
            title={<UserText>{peer.title}</UserText>}
            meta={peer.subtitle ? <BidiText text={peer.subtitle} /> : undefined}
          />
          <Toggle
            checked={enabled}
            label={t("plusAutoReplyChatOn")}
            onChange={(value) => setEnabled(value)}
          />
          <Field label={t("plusAutoReplyTrigger")} htmlFor="plus-chat-trigger">
            <Select
              id="plus-chat-trigger"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value as AutoReplyTrigger)}
            >
              {TRIGGERS.map((value) => (
                <option key={value} value={value}>
                  {triggerLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          {trigger === "keywords" && (
            <Field
              label={t("plusAutoReplyKeywords")}
              description={t("plusAutoReplyKeywordsHint")}
              error={keywordError}
            >
              <ChipInput
                value={keywords}
                onChange={setKeywords}
                max={PLUS_LIMITS.keywords}
                maxLength={PLUS_LIMITS.keywordChars}
                onReject={rejectKeyword}
                removeLabel={(word) => fill(t("removeKeyword"), { word })}
                countLabel={fill(t("plusAutoReplyKeywordCount"), {
                  n: keywords.length,
                  max: PLUS_LIMITS.keywords,
                })}
                placeholder={t("keywordsPlaceholder")}
                aria-label={t("plusAutoReplyKeywords")}
                aria-invalid={keywordError ? true : undefined}
              />
            </Field>
          )}
          <Field
            label={t("plusAutoReplyInstructions")}
            htmlFor="plus-chat-instructions"
            description={fill(t("plusTextCount"), {
              n: instructions.length,
              max: PLUS_LIMITS.instructions,
            })}
          >
            <Textarea
              id="plus-chat-instructions"
              dir="auto"
              rows={3}
              maxLength={PLUS_LIMITS.instructions}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
          <Toggle
            checked={globalMemoryRead}
            label={t("plusAutoReplyGlobalMemoryRead")}
            onChange={(checked) => {
              if (checked) {
                setConfirmMemory(true);
              } else {
                setGlobalMemoryRead(false);
              }
            }}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t("plusAutoReplyCooldown")}
              htmlFor="plus-chat-cooldown"
              error={cooldownError}
            >
              <Input
                id="plus-chat-cooldown"
                type="number"
                inputMode="numeric"
                min={PLUS_LIMITS.cooldownSeconds.min}
                max={PLUS_LIMITS.cooldownSeconds.max}
                value={cooldown}
                aria-invalid={cooldownError ? true : undefined}
                onChange={(event) => {
                  setCooldown(event.target.value);
                  setCooldownError(null);
                }}
              />
            </Field>
            <Field
              label={t("plusAutoReplyPerSender")}
              htmlFor="plus-chat-sender"
              error={perSenderError}
            >
              <Input
                id="plus-chat-sender"
                type="number"
                inputMode="numeric"
                min={PLUS_LIMITS.perSenderPerHour.min}
                max={PLUS_LIMITS.perSenderPerHour.max}
                value={perSender}
                aria-invalid={perSenderError ? true : undefined}
                onChange={(event) => {
                  setPerSender(event.target.value);
                  setPerSenderError(null);
                }}
              />
            </Field>
            <Field
              label={t("plusAutoReplyPerChat")}
              htmlFor="plus-chat-per-chat"
              error={perChatError}
            >
              <Input
                id="plus-chat-per-chat"
                type="number"
                inputMode="numeric"
                min={PLUS_LIMITS.perChatPerHour.min}
                max={PLUS_LIMITS.perChatPerHour.max}
                value={perChat}
                aria-invalid={perChatError ? true : undefined}
                onChange={(event) => {
                  setPerChat(event.target.value);
                  setPerChatError(null);
                }}
              />
            </Field>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        isOpen={confirmMemory}
        onClose={() => setConfirmMemory(false)}
        onConfirm={() => {
          setGlobalMemoryRead(true);
          setConfirmMemory(false);
        }}
        title={t("plusAutoReplyGlobalMemoryConfirmTitle")}
        description={t("plusAutoReplyGlobalMemoryReadWarning")}
        confirmLabel={t("turnOn")}
        cancelLabel={t("cancel")}
        variant="primary"
      />
    </>
  );
}
