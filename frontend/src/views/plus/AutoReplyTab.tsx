// file: frontend/src/views/plus/AutoReplyTab.tsx
import { Bot, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  Input,
  LoadingState,
  MenuItem,
  OverflowMenu,
  Toggle,
  useDirtyForm,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { AutoReplyChatEditor } from "./AutoReplyChatEditor";
import { plusErrorCode, plusErrorKey, plusGet, plusPut } from "./plusApi";
import {
  type AutoReplyChat,
  type AutoReplyConfig,
  type AutoReplyTrigger,
  PLUS_LIMITS,
} from "./types";

export function AutoReplyTab({ onInactive }: { onInactive: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AutoReplyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    plusGet<AutoReplyConfig>("/auto-reply")
      .then((result) => {
        if (!live) return;
        setConfig(result);
        setError(null);
      })
      .catch((err) => {
        if (!live) return;
        const code = plusErrorCode(err);
        if (code === "inactive") onInactive();
        setError(t(plusErrorKey(code)));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken, onInactive, t]);

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

  return <AutoReplyForm config={config} onSaved={setConfig} onInactive={onInactive} />;
}

function AutoReplyForm({
  config,
  onSaved,
  onInactive,
}: {
  config: AutoReplyConfig;
  onSaved: (next: AutoReplyConfig) => void;
  onInactive: () => void;
}) {
  const { t } = useI18n();
  const form = useDirtyForm<AutoReplyConfig>(config);
  const [editor, setEditor] = useState<{ chat: AutoReplyChat | null } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);

  const chats = form.draft.chats;
  const atChatLimit = chats.length >= PLUS_LIMITS.autoReplyChats;

  const triggerLabel = (value: AutoReplyTrigger) =>
    value === "mention"
      ? t("plusTriggerMention")
      : value === "keywords"
        ? t("plusTriggerKeywords")
        : t("plusTriggerAll");

  function submit(event: FormEvent) {
    event.preventDefault();
    const limit = form.draft.globalPerHour;
    const valid =
      Number.isInteger(limit) &&
      limit >= PLUS_LIMITS.globalPerHour.min &&
      limit <= PLUS_LIMITS.globalPerHour.max;
    setLimitError(
      valid
        ? null
        : fill(t("plusAutoReplyRange"), {
            min: PLUS_LIMITS.globalPerHour.min,
            max: PLUS_LIMITS.globalPerHour.max,
          }),
    );
    if (!valid) return;
    void form.save(async (draft) => {
      try {
        const next = await plusPut<AutoReplyConfig>("/auto-reply", draft);
        onSaved(next);
      } catch (err) {
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

  return (
    <Card className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("plusAutoReplyIntro")}</p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Toggle
          checked={form.draft.enabled}
          label={t("plusAutoReplyEnabled")}
          onChange={(value) => form.setField("enabled", value)}
        />
        <Toggle
          checked={form.draft.killSwitch}
          label={t("plusAutoReplyKill")}
          description={t("plusAutoReplyKillHint")}
          onChange={(value) => form.setField("killSwitch", value)}
        />
        <Field
          label={t("plusAutoReplyGlobalLimit")}
          htmlFor="plus-auto-reply-global"
          error={limitError}
        >
          <Input
            id="plus-auto-reply-global"
            type="number"
            inputMode="numeric"
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
              icon={<Plus size={16} />}
              disabled={atChatLimit}
              onClick={() => setEditor({ chat: null })}
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
              {chats.map((chat) => (
                <li
                  key={chat.jid}
                  className="flex flex-col gap-2 rounded-xl border border-line bg-panel-raised/40 p-3 sm:flex-row sm:items-start"
                >
                  <div className="min-w-0 flex-1">
                    <span dir="ltr" className="block break-all font-mono text-sm text-text-main">
                      {chat.jid}
                    </span>
                    <p className="mt-1 text-xs text-muted">
                      {fill(t("plusAutoReplyRowHint"), {
                        cooldown: chat.cooldownSeconds,
                        sender: chat.perSenderPerHour,
                        chat: chat.perChatPerHour,
                      })}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
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
                  </div>
                  <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                    <IconButton
                      label={t("plusAutoReplyEditChat")}
                      icon={<Pencil size={16} />}
                      onClick={() => setEditor({ chat })}
                    />
                    <OverflowMenu label={t("more")}>
                      <MenuItem onSelect={() => toggleChat(chat)}>
                        {chat.enabled ? t("plusAutoReplyDisable") : t("plusAutoReplyEnable")}
                      </MenuItem>
                      <MenuItem
                        danger
                        icon={<Trash2 size={16} />}
                        onSelect={() => setPendingRemove(chat.jid)}
                      >
                        {t("plusAutoReplyRemove")}
                      </MenuItem>
                    </OverflowMenu>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FormActions
          dirty={form.dirty}
          saving={form.status === "saving"}
          justSaved={form.status === "saved"}
          error={form.error ? t(plusErrorKey(form.error)) : null}
          onDiscard={form.revert}
          saveLabel={t("save")}
          discardLabel={t("discard")}
          unsavedLabel={t("unsavedChanges")}
          savedLabel={t("saved")}
        />
      </form>

      {editor && (
        <AutoReplyChatEditor
          chat={editor.chat}
          existingJids={chats
            .filter((chat) => chat.jid !== editor.chat?.jid)
            .map((chat) => chat.jid)}
          onClose={() => setEditor(null)}
          onSaved={(chat) => {
            const previous = editor.chat;
            form.setField(
              "chats",
              previous
                ? chats.map((item) => (item.jid === previous.jid ? chat : item))
                : [...chats, chat],
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
            form.setField(
              "chats",
              chats.filter((chat) => chat.jid !== pendingRemove),
            );
          }
          setPendingRemove(null);
        }}
        title={t("plusAutoReplyRemoveTitle")}
        description={t("plusAutoReplyRemoveBody")}
        confirmLabel={t("plusAutoReplyRemove")}
        cancelLabel={t("cancel")}
      />
    </Card>
  );
}
