import type React from "react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { RecipientPicker } from "../../components/RecipientPicker";
import {
  Button,
  Chip,
  ChipInput,
  type ChipRejectReason,
  Dialog,
  Field,
  Input,
  SegmentedControl,
  Toggle,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { AutoDeleteChatScope, AutoDeleteMatch, AutoDeleteRule } from "../../types";
import {
  AUTO_DELETE_LIMITS,
  draftToInput,
  normalizeSenderEntry,
  peerDir,
  peerLabel,
  prepareKeyword,
  type RuleDraft,
  SenderInputError,
  validateRuleDraft,
} from "../../utils/autoDelete";
import { fill } from "../../utils/fill";

interface RuleEditorProps {
  open: boolean;
  rule: AutoDeleteRule | null;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: (rule: AutoDeleteRule) => void;
}

const MATCHES: AutoDeleteMatch[] = ["contains", "word", "exact"];
const SCOPES: AutoDeleteChatScope[] = ["all", "groups", "private"];

export const RuleEditor: React.FC<RuleEditorProps> = ({ open, rule, names, onClose, onSaved }) => {
  const { t } = useI18n();
  const sourceRef = useRef(rule);
  sourceRef.current = rule;
  const ruleId = rule?.id ?? null;

  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [match, setMatch] = useState<AutoDeleteMatch>("contains");
  const [chatScope, setChatScope] = useState<AutoDeleteChatScope>("all");
  const [sendersMode, setSendersMode] = useState<"everyone" | "selected">("everyone");
  const [senders, setSenders] = useState<string[]>([]);
  const [includeOwn, setIncludeOwn] = useState(false);
  const [forEveryone, setForEveryone] = useState(true);
  const [keepCopy, setKeepCopy] = useState(false);
  const [phone, setPhone] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [senderError, setSenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const source = sourceRef.current;
    if ((source?.id ?? null) !== ruleId) return;
    setName(source?.name ?? "");
    setKeywords(source?.keywords ?? []);
    setMatch(source?.match ?? "contains");
    setChatScope(source?.chatScope ?? "all");
    setSendersMode(source?.senders.mode ?? "everyone");
    setSenders(source?.senders.list ?? []);
    setIncludeOwn(source?.includeOwn ?? false);
    setForEveryone(source?.forEveryone ?? true);
    setKeepCopy(source?.keepCopy ?? false);
    setPhone("");
    setPickerOpen(false);
    setBusy(false);
    setFormError(null);
    setNameError(null);
    setKeywordError(null);
    setSenderError(null);
  }, [open, ruleId]);

  const matchHint =
    match === "word"
      ? t("matchWordHint")
      : match === "exact"
        ? t("matchExactHint")
        : t("matchContainsHint");

  const rejectKeyword = (reason: ChipRejectReason | null) => {
    if (reason === "long") setKeywordError(t("keywordTooLong"));
    else if (reason === "max") setKeywordError(t("keywordsMax"));
    else if (reason === "empty") setKeywordError(t("keywordEmpty"));
    else if (reason === "duplicate") setKeywordError(t("keywordDuplicate"));
    else setKeywordError(null);
  };

  const addSender = (raw: string) => {
    try {
      const id = normalizeSenderEntry(raw);
      if (senders.includes(id)) {
        setPhone("");
        setSenderError(null);
        return;
      }
      if (senders.length >= AUTO_DELETE_LIMITS.senders) {
        setSenderError(t("tooManySenders"));
        return;
      }
      setSenders((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setPhone("");
      setSenderError(null);
    } catch (err) {
      setSenderError(
        err instanceof SenderInputError && err.reason === "group"
          ? t("groupSenderRejected")
          : t("invalidPhone"),
      );
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const draft: RuleDraft = {
      name,
      keywords,
      match,
      chatScope,
      sendersMode,
      senders,
      includeOwn,
      forEveryone,
      keepCopy,
    };
    const problems = validateRuleDraft(draft);
    setNameError(problems.name ? t("nameTooLong") : null);
    setKeywordError(
      problems.keywords === "required"
        ? t("keywordsRequired")
        : problems.keywords === "max"
          ? t("keywordsMax")
          : null,
    );
    setSenderError(
      problems.senders === "required"
        ? t("sendersRequired")
        : problems.senders === "max"
          ? t("tooManySenders")
          : null,
    );
    if (problems.name || problems.keywords || problems.senders) return;

    setBusy(true);
    setFormError(null);
    try {
      const body = draftToInput(draft, sourceRef.current?.enabled);
      const res = sourceRef.current
        ? await api.updateAutoDeleteRule(sourceRef.current.id, body)
        : await api.createAutoDeleteRule(body);
      onSaved(res.rule);
    } catch (err) {
      const message = err instanceof ApiError && err.message ? err.message : t("ruleSaveFailed");
      setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        isOpen={open}
        onClose={onClose}
        title={rule ? t("editRule") : t("newRule")}
        maxWidth="40rem"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button variant="primary" type="submit" form="auto-delete-rule-form" loading={busy}>
              {t("saveRule")}
            </Button>
          </>
        }
      >
        <form
          id="auto-delete-rule-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <Field label={t("ruleName")} htmlFor="ad-rule-name" error={nameError}>
            <Input
              id="ad-rule-name"
              name="rule-name"
              dir="auto"
              value={name}
              aria-invalid={nameError ? true : undefined}
              placeholder={t("ruleNamePlaceholder")}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError && event.target.value.trim().length <= AUTO_DELETE_LIMITS.nameChars) {
                  setNameError(null);
                }
              }}
              onBlur={() => {
                if (name.trim().length > AUTO_DELETE_LIMITS.nameChars)
                  setNameError(t("nameTooLong"));
              }}
            />
          </Field>
          <Field label={t("keywordsLabel")} error={keywordError}>
            <ChipInput
              id="ad-keywords"
              value={keywords}
              onChange={setKeywords}
              max={AUTO_DELETE_LIMITS.keywords}
              prepare={prepareKeyword}
              onReject={rejectKeyword}
              removeLabel={(word) => fill(t("removeKeyword"), { word })}
              countLabel={fill(t("keywordCount"), {
                n: keywords.length,
                max: AUTO_DELETE_LIMITS.keywords,
              })}
              placeholder={t("keywordsPlaceholder")}
              aria-label={t("keywordsLabel")}
              aria-invalid={keywordError ? true : undefined}
              disabled={busy}
            />
          </Field>
          <Field label={t("matchMode")} description={matchHint}>
            <SegmentedControl
              aria-label={t("matchMode")}
              className="flex w-full flex-wrap"
              value={match}
              onChange={setMatch}
              options={MATCHES.map((value) => ({
                value,
                label: t(
                  value === "contains"
                    ? "matchContains"
                    : value === "word"
                      ? "matchWord"
                      : "matchExact",
                ),
              }))}
            />
          </Field>
          <Field label={t("chatScopeLabel")}>
            <SegmentedControl
              aria-label={t("chatScopeLabel")}
              className="flex w-full flex-wrap"
              value={chatScope}
              onChange={setChatScope}
              options={SCOPES.map((value) => ({
                value,
                label: t(
                  value === "all"
                    ? "chatsAll"
                    : value === "groups"
                      ? "chatsGroups"
                      : "chatsPrivate",
                ),
              }))}
            />
          </Field>
          <Field label={t("filterSender")} error={sendersMode === "selected" ? senderError : null}>
            <SegmentedControl
              aria-label={t("filterSender")}
              className="flex w-full flex-wrap"
              value={sendersMode}
              onChange={setSendersMode}
              options={[
                { value: "everyone", label: t("sendersEveryone") },
                { value: "selected", label: t("sendersSelected") },
              ]}
            />
            {sendersMode === "selected" && (
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-xs text-muted">{t("sendersHelp")}</p>
                {senders.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {senders.map((id) => (
                      <Chip
                        key={id}
                        dir={peerDir(id, names)}
                        removeLabel={fill(t("removeContact"), { name: peerLabel(id, names) })}
                        onRemove={() => setSenders((prev) => prev.filter((item) => item !== id))}
                      >
                        {peerLabel(id, names)}
                      </Chip>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="tel"
                    inputMode="tel"
                    name="phone"
                    autoComplete="tel"
                    dir="ltr"
                    value={phone}
                    placeholder={t("phonePlaceholder")}
                    aria-label={t("phonePlaceholder")}
                    className="min-w-0 flex-1"
                    onChange={(event) => setPhone(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addSender(phone);
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={() => addSender(phone)}>
                    {t("addPhone")}
                  </Button>
                </div>
                <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)}>
                  {t("selectContacts")}
                </Button>
              </div>
            )}
          </Field>
          <Toggle
            checked={includeOwn}
            onChange={setIncludeOwn}
            label={t("includeOwn")}
            description={t("includeOwnHint")}
          />
          <Toggle
            checked={forEveryone}
            onChange={setForEveryone}
            label={t("forEveryone")}
            description={t("forEveryoneHint")}
          />
          <div className="flex flex-col gap-1.5">
            <Toggle
              checked={keepCopy}
              onChange={setKeepCopy}
              label={t("keepCopy")}
              description={t("keepCopyHint")}
            />
            <p className="text-xs text-faint">{t("keepCopyPrivacy")}</p>
          </div>
        </form>
      </Dialog>
      <RecipientPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t("selectContacts")}
        includeGroups={false}
        selectedIds={senders}
        emptyText={t("noContacts")}
        onPick={(jid) => addSender(jid)}
      />
    </>
  );
};
