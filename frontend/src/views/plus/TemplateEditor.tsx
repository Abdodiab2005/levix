// file: frontend/src/views/plus/TemplateEditor.tsx
import { RotateCcw, Undo2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import {
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  Disclosure,
  Field,
  MenuItem,
  MenuSeparator,
  OverflowMenu,
  SegmentedControl,
  Select,
  Textarea,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { plusDelete, plusErrorCode, plusErrorKey, plusGet, plusPut } from "./plusApi";
import { getDraftText, substitutePlaceholders } from "./plusUiLogic";
import {
  LOCALE_NAMES,
  PLUS_LIMITS,
  PLUS_LOCALES,
  type PlusLocale,
  type PlusTemplateKey,
  type PlusTemplateMode,
  type PlusTemplateOverride,
  type PlusTemplateSave,
  isPlusLocale,
} from "./types";

const MODES: PlusTemplateMode[] = ["auto", "original"];

function placeholdersIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export function TemplateEditor({
  open,
  item,
  onClose,
  onSaved,
  onRefresh,
  onInactive,
}: {
  open: boolean;
  item: PlusTemplateKey | null;
  onClose: () => void;
  onSaved: (override: PlusTemplateOverride | null) => void;
  onRefresh: () => void;
  onInactive: () => void;
}) {
  const { t, language } = useI18n();
  const itemRef = useRef(item);
  itemRef.current = item;

  const [mode, setMode] = useState<PlusTemplateMode>("auto");
  const [sourceLocale, setSourceLocale] = useState<PlusLocale>(
    isPlusLocale(language) ? language : "en",
  );
  const [text, setText] = useState("");
  const [manual, setManual] = useState<Partial<Record<PlusLocale, string>>>({});
  const [failed, setFailed] = useState<PlusLocale[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewToken, setPreviewToken] = useState(0);
  const savedBaselineRef = useRef<{
    mode: PlusTemplateMode;
    sourceLocale: PlusLocale;
    text: string;
    manual: Partial<Record<PlusLocale, string>>;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const source = itemRef.current;
    if (!source) return;
    const override = source.override;
    const panel = isPlusLocale(language) ? language : "en";
    const initialMode = override?.mode ?? "auto";
    const initialSourceLocale = override?.source.locale ?? panel;
    const initialText = override?.source.text ?? source.catalog[panel] ?? source.catalog.en ?? "";
    setMode(initialMode);
    setSourceLocale(initialSourceLocale);
    setText(initialText);
    const manualValues: Partial<Record<PlusLocale, string>> = {};
    for (const locale of override?.manual ?? []) {
      const value = override?.values[locale];
      if (typeof value === "string") manualValues[locale] = value;
    }
    setManual(manualValues);
    savedBaselineRef.current = {
      mode: initialMode,
      sourceLocale: initialSourceLocale,
      text: initialText,
      manual: manualValues,
    };
    setFailed(override?.failed ?? []);
    setError(null);
    setWarn(null);
    setSaving(false);
    setRestoring(false);
    setConfirmRestore(false);
    setPreviewToken((value) => value + 1);
  }, [open, item?.key, language]);

  const isDirty = Boolean(
    savedBaselineRef.current &&
      (mode !== savedBaselineRef.current.mode ||
        sourceLocale !== savedBaselineRef.current.sourceLocale ||
        text !== savedBaselineRef.current.text ||
        PLUS_LOCALES.some(
          (loc) =>
            (manual[loc] ?? "").trim() !== (savedBaselineRef.current?.manual[loc] ?? "").trim(),
        )),
  );
  const hasDraft = isDirty && text.trim().length > 0;
  const draftText = getDraftText(sourceLocale, mode, sourceLocale, text, manual);
  const localPreview = substitutePlaceholders(draftText);

  useEffect(() => {
    if (!open) return;
    const key = itemRef.current?.key;
    if (!key) return;
    if (hasDraft) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setPreviewFailed(false);
      plusGet<{ text: string }>(
        `/preview?key=${encodeURIComponent(key)}&locale=${encodeURIComponent(sourceLocale)}`,
      )
        .then((result) => {
          if (!live) return;
          setPreview(result.text);
        })
        .catch((err) => {
          if (!live) return;
          if (plusErrorCode(err) === "inactive") onInactive();
          setPreview(null);
          setPreviewFailed(true);
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, item?.key, sourceLocale, previewToken, onInactive, hasDraft]);

  const key = item?.key ?? "";
  const catalog: Partial<Record<PlusLocale, string>> = item?.catalog ?? {};
  const allowed = item?.placeholders ?? [];

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!item) return;
    const value = text.trim();
    if (!value) {
      setError(t("plusTextRequired"));
      return;
    }
    if (value.length > PLUS_LIMITS.templateText) {
      setError(t("plusTextTooLong"));
      return;
    }
    const unknown = placeholdersIn(value).filter((name) => !allowed.includes(name));
    if (unknown.length > 0) {
      setError(fill(t("plusPlaceholderUnknown"), { names: unknown.join(", ") }));
      return;
    }
    const manualValues: Partial<Record<PlusLocale, string>> = {};
    for (const locale of PLUS_LOCALES) {
      if (locale === sourceLocale) continue;
      const typed = manual[locale]?.trim();
      if (!typed) continue;
      if (typed.length > PLUS_LIMITS.templateText) {
        setError(t("plusTextTooLong"));
        return;
      }
      manualValues[locale] = typed;
    }

    const body: PlusTemplateSave = { mode, locale: sourceLocale, text: value };
    if (Object.keys(manualValues).length > 0) body.manual = manualValues;

    setSaving(true);
    setError(null);
    setWarn(null);
    try {
      const result = await plusPut<{ override: PlusTemplateOverride }>(
        `/templates/${encodeURIComponent(item.key)}`,
        body,
      );
      setFailed(result.override.failed ?? []);
      if ((result.override.failed ?? []).length > 0) setWarn(t("plusExtErrorTranslateFailed"));
      savedBaselineRef.current = {
        mode,
        sourceLocale,
        text: value,
        manual: manualValues,
      };
      onSaved(result.override);
      setPreviewToken((token) => token + 1);
    } catch (err) {
      const code = plusErrorCode(err);
      if (code === "inactive") onInactive();
      if (code === "TRANSLATE_FAILED") {
        setWarn(t("plusExtErrorTranslateFailed"));
        const saved: { override?: PlusTemplateOverride } =
          err instanceof ApiError
            ? ((err.data as { override?: PlusTemplateOverride } | null) ?? {})
            : {};
        if (saved.override) {
          setFailed(saved.override.failed ?? []);
          onSaved(saved.override);
        }
        onRefresh();
      } else {
        setError(t(plusErrorKey(code)));
      }
    } finally {
      setSaving(false);
    }
  }

  async function restore() {
    if (!item) return;
    setRestoring(true);
    setError(null);
    try {
      await plusDelete<{ ok: boolean }>(`/templates/${encodeURIComponent(item.key)}`);
      onSaved(null);
      onClose();
    } catch (err) {
      const code = plusErrorCode(err);
      if (code === "inactive") onInactive();
      setError(t(plusErrorKey(code)));
    } finally {
      setRestoring(false);
      setConfirmRestore(false);
    }
  }

  const failedNames = failed.map((locale) => LOCALE_NAMES[locale] ?? locale).join(", ");
  const otherLocales = PLUS_LOCALES.filter((locale) => locale !== sourceLocale);
  const manualCount = otherLocales.filter(
    (locale) => (manual[locale] ?? "").trim().length > 0,
  ).length;

  return (
    <>
      <Dialog
        isOpen={open}
        onClose={onClose}
        title={t("plusMessagesEdit")}
        description={
          <span dir="ltr" className="font-mono text-xs">
            {key}
          </span>
        }
        maxWidth="44rem"
        footer={
          <>
            <OverflowMenu label={t("more")} align="start">
              <MenuItem
                icon={<Undo2 size={16} />}
                disabled={manualCount === 0}
                onSelect={() => setManual({})}
              >
                {t("plusClearManual")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<RotateCcw size={16} />}
                onSelect={() => setConfirmRestore(true)}
              >
                {t("plusRestoreDefault")}
              </MenuItem>
            </OverflowMenu>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button variant="primary" type="submit" form="plus-template-form" loading={saving}>
              {t("save")}
            </Button>
          </>
        }
      >
        <form
          id="plus-template-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => void save(event)}
        >
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {warn && (
            <p role="status" className="text-sm text-warn">
              {warn}
            </p>
          )}
          <Field
            label={t("plusMessagesMode")}
            description={mode === "auto" ? t("plusModeAutoHint") : t("plusModeOriginalHint")}
          >
            <SegmentedControl
              aria-label={t("plusMessagesMode")}
              className="flex w-full flex-wrap"
              value={mode}
              onChange={setMode}
              options={MODES.map((value) => ({
                value,
                label: value === "auto" ? t("plusModeAuto") : t("plusModeOriginal"),
              }))}
            />
          </Field>
          <Field label={t("plusSourceLanguage")} htmlFor="plus-template-locale">
            <Select
              id="plus-template-locale"
              value={sourceLocale}
              onChange={(event) => {
                const next = event.target.value;
                if (isPlusLocale(next)) setSourceLocale(next);
              }}
            >
              {PLUS_LOCALES.map((locale) => (
                <option key={locale} value={locale} dir="auto">
                  {LOCALE_NAMES[locale]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t("plusSourceText")}
            htmlFor="plus-template-text"
            description={fill(t("plusTextCount"), {
              n: text.length,
              max: PLUS_LIMITS.templateText,
            })}
          >
            <Textarea
              id="plus-template-text"
              value={text}
              dir="auto"
              rows={4}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-bold text-text-main">{t("plusMessagesPlaceholders")}</p>
            {allowed.length === 0 ? (
              <p className="text-xs text-muted">{t("plusMessagesNoPlaceholders")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allowed.map((name) => (
                  <Chip key={name} dir="ltr" className="font-mono">
                    {`{${name}}`}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-bold text-text-main">{t("plusMessagesPreview")}</p>
            <p
              dir="auto"
              className="rounded-xl border border-line bg-panel-raised/50 p-3 text-sm text-text-main whitespace-pre-wrap break-words"
            >
              {hasDraft ? (
                localPreview
              ) : previewFailed ? (
                <span className="text-muted">{t("plusMessagesPreviewFailed")}</span>
              ) : (
                (preview ?? localPreview)
              )}
            </p>
          </div>
          {failed.length > 0 && (
            <p className="text-sm text-warn">
              {t("plusFailedTitle")} <span dir="auto">{failedNames}</span>
            </p>
          )}
          <Disclosure
            summary={<span className="text-sm font-semibold">{t("plusManualTitle")}</span>}
          >
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted">{t("plusManualHint")}</p>
              {otherLocales.map((locale) => (
                <Field key={locale} label={LOCALE_NAMES[locale]} htmlFor={`plus-manual-${locale}`}>
                  <Textarea
                    id={`plus-manual-${locale}`}
                    dir="auto"
                    rows={3}
                    value={manual[locale] ?? ""}
                    placeholder={catalog[locale] ?? catalog.en ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setManual((prev) => ({ ...prev, [locale]: value }));
                      setError(null);
                    }}
                  />
                </Field>
              ))}
            </div>
          </Disclosure>
        </form>
      </Dialog>
      <ConfirmDialog
        isOpen={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        onConfirm={() => void restore()}
        title={t("plusRestoreDefaultTitle")}
        description={t("plusRestoreDefaultBody")}
        confirmLabel={t("plusRestoreDefault")}
        cancelLabel={t("cancel")}
        loading={restoring}
      />
    </>
  );
}
