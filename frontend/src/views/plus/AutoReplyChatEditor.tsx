// file: frontend/src/views/plus/AutoReplyChatEditor.tsx
import { type FormEvent, useRef, useState } from "react";
import {
  Button,
  ChipInput,
  type ChipRejectReason,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Section,
  Select,
  Textarea,
  Toggle,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import {
  type AutoReplyChat,
  type AutoReplyTrigger,
  CHAT_JID_PATTERN,
  PLUS_LIMITS,
  isGroupJid,
} from "./types";

const TRIGGERS: AutoReplyTrigger[] = ["all", "mention", "keywords"];

function readInteger(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function AutoReplyChatEditor({
  onClose,
  onSaved,
  chat,
  existingJids,
}: {
  onClose: () => void;
  onSaved: (chat: AutoReplyChat) => void;
  chat: AutoReplyChat | null;
  existingJids: string[];
}) {
  const { t } = useI18n();
  const [jid, setJid] = useState(chat?.jid ?? "");
  const [enabled, setEnabled] = useState(chat?.enabled ?? true);
  const [trigger, setTrigger] = useState<AutoReplyTrigger>(
    chat?.trigger ?? (chat && isGroupJid(chat.jid) ? "mention" : "all"),
  );
  const [keywords, setKeywords] = useState<string[]>(chat?.keywords ?? []);
  const [instructions, setInstructions] = useState(chat?.instructions ?? "");
  const [cooldown, setCooldown] = useState(String(chat?.cooldownSeconds ?? 20));
  const [perSender, setPerSender] = useState(String(chat?.perSenderPerHour ?? 10));
  const [perChat, setPerChat] = useState(String(chat?.perChatPerHour ?? 30));
  const [globalMemoryRead, setGlobalMemoryRead] = useState(chat?.globalMemory?.read ?? false);
  const [confirmMemory, setConfirmMemory] = useState(false);
  const [jidError, setJidError] = useState<string | null>(null);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [cooldownError, setCooldownError] = useState<string | null>(null);
  const [perSenderError, setPerSenderError] = useState<string | null>(null);
  const [perChatError, setPerChatError] = useState<string | null>(null);
  const triggerTouched = useRef(chat !== null);

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
    const value = jid.trim();
    const jidProblem = !CHAT_JID_PATTERN.test(value)
      ? t("plusAutoReplyInvalidJid")
      : existingJids.includes(value)
        ? t("plusAutoReplyDuplicateJid")
        : null;
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

    setJidError(jidProblem);
    setCooldownError(cooldownProblem);
    setPerSenderError(senderProblem);
    setPerChatError(chatProblem);
    if (jidProblem || cooldownProblem || senderProblem || chatProblem) return;

    onSaved({
      jid: value,
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
        title={chat ? t("plusAutoReplyEditChat") : t("plusAutoReplyAddChat")}
        maxWidth="40rem"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" type="submit" form="plus-auto-reply-chat">
              {t("save")}
            </Button>
          </>
        }
      >
        <form
          id="plus-auto-reply-chat"
          className="flex flex-col gap-4"
          onSubmit={(event) => submit(event)}
        >
          <Toggle
            checked={enabled}
            label={t("plusAutoReplyChatOn")}
            onChange={(value) => setEnabled(value)}
          />
          <Field label={t("plusAutoReplyJid")} htmlFor="plus-chat-jid" error={jidError}>
            <Input
              id="plus-chat-jid"
              technical
              value={jid}
              placeholder="201234567890@s.whatsapp.net"
              aria-invalid={jidError ? true : undefined}
              onChange={(event) => {
                const value = event.target.value;
                setJid(value);
                setJidError(null);
                if (!triggerTouched.current) {
                  setTrigger(value.trim().endsWith("@g.us") ? "mention" : "all");
                }
              }}
            />
          </Field>
          <p className="text-xs text-muted">{t("plusAutoReplyJidHint")}</p>
          <Field label={t("plusAutoReplyTrigger")} htmlFor="plus-chat-trigger">
            <Select
              id="plus-chat-trigger"
              value={trigger}
              onChange={(event) => {
                triggerTouched.current = true;
                setTrigger(event.target.value as AutoReplyTrigger);
              }}
            >
              {TRIGGERS.map((value) => (
                <option key={value} value={value}>
                  {triggerLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          {trigger === "keywords" && (
            <Field label={t("plusAutoReplyKeywords")} error={keywordError}>
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
              <p className="text-xs text-muted">{t("plusAutoReplyKeywordsHint")}</p>
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
              rows={4}
              maxLength={PLUS_LIMITS.instructions}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
          <p className="text-xs text-muted">{t("plusAutoReplyInstructionsHint")}</p>
          <Section title={t("plusAutoReplyGlobalMemoryTitle")}>
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
          </Section>
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
