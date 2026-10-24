// file: frontend/src/components/FeedbackForm.tsx

import {
  Bug,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HeartHandshake,
  Lightbulb,
  Paperclip,
  Send,
  Shield,
  Sparkles,
  Star,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api, type FeedbackMeta, type FeedbackTopic } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { formatByteSize } from "../utils/byteSize";
import { getClientDiagnostics } from "../utils/diagnostics";
import type { HostSource } from "../utils/hostBridge";
import { canHostUploadForm, pickHostFile, uploadHostForm } from "../utils/hostBridge";
import { DebugLogPreview } from "./DebugLogPreview";
import { useToast } from "./Toasts";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  Field,
  IconButton,
  Input,
  Spinner,
  Tabs,
  Textarea,
} from "./ui";

/**
 * The panel's line to the developer, and the app's answer to Google Play's
 * expectation that a user can reach whoever built it. The bot forwards what is
 * written here to levix.leviro.net/api/feedback from the server side, so this
 * form never talks to anything but the panel it is already signed in to.
 *
 * An optional file rides along (screenshot, log): on the browser it is a
 * multipart XHR so the upload can show progress; on the Android host the
 * native bridge streams it instead, because the WebView bridge cannot carry
 * FormData.
 *
 * The limits below are re-checked by the backend (src/panel/feedback.cjs); they
 * are here to answer the operator immediately, not to be trusted.
 */

const FALLBACK = { messageMin: 10, messageMax: 2000, attachmentMax: 20 * 1024 * 1024 };

const TOPIC_META: Record<
  FeedbackTopic,
  {
    icon: typeof Bug;
    labelKey:
      | "feedbackTopicBug"
      | "feedbackTopicIdea"
      | "feedbackTopicQuestion"
      | "feedbackTopicPraise"
      | "feedbackTopicOther";
  }
> = {
  bug: { icon: Bug, labelKey: "feedbackTopicBug" },
  idea: { icon: Lightbulb, labelKey: "feedbackTopicIdea" },
  question: { icon: Sparkles, labelKey: "feedbackTopicQuestion" },
  praise: { icon: HeartHandshake, labelKey: "feedbackTopicPraise" },
  other: { icon: Send, labelKey: "feedbackTopicOther" },
};

const TOPIC_ORDER: FeedbackTopic[] = ["bug", "idea", "question", "praise", "other"];

export const FeedbackForm: React.FC = () => {
  const { t, language, theme } = useI18n();
  const { toast } = useToast();

  const [meta, setMeta] = useState<FeedbackMeta | null>(null);
  const [topic, setTopic] = useState<FeedbackTopic>("bug");
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(0);
  const [contact, setContact] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [hostFile, setHostFile] = useState<HostSource | null>(null);
  const [attachDiagnostics, setAttachDiagnostics] = useState(false);
  const [previewData, setPreviewData] = useState<Record<string, any> | null>(null);
  const [previewDebugLog, setPreviewDebugLog] = useState("");
  const [previewDebugLogId, setPreviewDebugLogId] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Only the limits and the runtime line; a failure here leaves the form
    // usable with the defaults above.
    api
      .getFeedbackMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!attachDiagnostics) {
      setPreviewData(null);
      setPreviewDebugLog("");
      setPreviewDebugLogId("");
      return;
    }
    const clientDiag = getClientDiagnostics(language, theme);
    setPreviewLoading(true);
    api
      .getFeedbackDiagnosticsPreview(clientDiag)
      .then((res) => {
        if (res?.diagnostics) {
          setPreviewData(res.diagnostics);
          setPreviewDebugLog(res.debugLog || "");
          setPreviewDebugLogId(typeof res.debugLogId === "string" ? res.debugLogId : "");
        } else {
          setPreviewData(clientDiag);
          setPreviewDebugLog("");
          setPreviewDebugLogId("");
        }
      })
      .catch(() => {
        setPreviewData(clientDiag);
        setPreviewDebugLog("");
        setPreviewDebugLogId("");
      })
      .finally(() => {
        setPreviewLoading(false);
      });
  }, [attachDiagnostics, language, theme]);

  const messageMin = meta?.messageMin ?? FALLBACK.messageMin;
  const messageMax = meta?.messageMax ?? FALLBACK.messageMax;
  const attachmentMax = meta?.attachmentMax ?? FALLBACK.attachmentMax;
  const attachmentMaxMb = Math.round(attachmentMax / (1024 * 1024));
  const trimmed = message.trim();
  const missing = Math.max(0, messageMin - trimmed.length);

  /** Chip caption for the chosen file: `screenshot.png · 1.2 MB`. */
  const formatFileSize = (bytes: number): string => formatByteSize(bytes, t);

  const topics = (meta?.topics?.length ? meta.topics : TOPIC_ORDER).filter(
    (id) => id in TOPIC_META,
  );

  const tooLargeToast = () =>
    toast(t("feedbackFileTooLarge").replace("{max}", String(attachmentMaxMb)), "error");

  const pickHostAttachment = async () => {
    try {
      const picked = await pickHostFile();
      if (!picked) return;
      if (picked.size > attachmentMax) {
        tooLargeToast();
        return;
      }
      setHostFile(picked);
    } catch (err: any) {
      toast(err?.message || "Could not attach the file", "error");
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (missing > 0 || sending) return;

    setSending(true);
    setProgress(hostFile ? 0 : null);
    const clientDiag = attachDiagnostics ? getClientDiagnostics(language, theme) : undefined;
    const payload = {
      message: trimmed,
      topic,
      rating: rating || null,
      contact: contact.trim() || null,
      ...(clientDiag ? { diagnostics: clientDiag } : {}),
      ...(clientDiag && previewDebugLogId ? { debugLogId: previewDebugLogId } : {}),
    };
    try {
      if (hostFile) {
        await uploadHostForm<{ success: boolean }>(
          "/dashboard/api/feedback",
          {
            message: payload.message,
            topic: payload.topic,
            ...(payload.rating ? { rating: String(payload.rating) } : {}),
            ...(payload.contact ? { contact: payload.contact } : {}),
            ...(clientDiag ? { diagnostics: JSON.stringify(clientDiag) } : {}),
            ...(clientDiag && previewDebugLogId ? { debugLogId: previewDebugLogId } : {}),
          },
          hostFile.token,
          attachmentMax + 1024 * 1024,
        );
      } else if (attachment) {
        await api.sendFeedbackMultipart(payload, attachment, (fraction) => setProgress(fraction));
      } else {
        await api.sendFeedback(payload);
      }
      setSent(true);
      toast(t("feedbackSent"), "success");
    } catch (err: any) {
      toast(err?.message, "error");
    } finally {
      setSending(false);
      setProgress(null);
    }
  };

  const reset = () => {
    setMessage("");
    setContact("");
    setRating(0);
    setTopic("bug");
    setAttachment(null);
    setHostFile(null);
    setAttachDiagnostics(false);
    setPreviewData(null);
    setPreviewOpen(false);
    setSent(false);
  };

  const clearAttachment = () => {
    setAttachment(null);
    setHostFile(null);
  };

  if (sent) {
    return (
      <Card className="border-ok/30 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-ok/10 text-ok">
          <CheckCircle2 size={26} />
        </div>
        <h3 className="mt-4 text-lg font-bold text-text-main">{t("feedbackSent")}</h3>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted sm:text-sm">
          {t("feedbackSentDesc")}
        </p>
        <Button className="mt-6" onClick={reset}>
          {t("feedbackSendAnother")}
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <form onSubmit={handleSend} className="flex flex-col gap-5">
          <div className="flex items-center gap-3 pb-4 border-b border-line">
            <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
              <Send size={20} />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-text-main">
                {t("feedbackTitle")}
              </h3>
              <p className="text-xs sm:text-sm text-muted mt-0.5">{t("feedbackDesc")}</p>
            </div>
          </div>

          <Field label={t("feedbackTopicLabel")}>
            <Tabs
              aria-label={t("feedbackTopicLabel")}
              value={topic}
              onChange={setTopic}
              className="flex-wrap gap-1.5 sm:gap-2"
              options={topics.map((id) => {
                const Icon = TOPIC_META[id].icon;
                return {
                  value: id,
                  label: t(TOPIC_META[id].labelKey),
                  icon: <Icon size={16} />,
                };
              })}
            />
          </Field>

          <Field label={t("feedbackMessageLabel")} htmlFor="feedback-message">
            <Textarea
              id="feedback-message"
              rows={6}
              required
              maxLength={messageMax}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("feedbackMessagePlaceholder")}
            />
            <span className="self-end text-[11px] tabular-nums text-muted">
              {missing > 0
                ? `${missing} ${t("feedbackCharsNeeded")}`
                : `${message.length} / ${messageMax}`}
            </span>
          </Field>

          {/* attachment: a dashed drop-zone, its hint under it, the file as a chip */}
          <Field
            label={t("feedbackAttach")}
            description={t("feedbackAttachmentHint").replace("{max}", String(attachmentMaxMb))}
          >
            {hostFile || attachment ? (
              <span className="flex">
                <Chip
                  onRemove={clearAttachment}
                  removeLabel={t("feedbackRemoveAttachment")}
                  className="max-w-full"
                >
                  {`${hostFile?.name ?? attachment?.name} · ${formatFileSize(
                    hostFile?.size ?? attachment?.size ?? 0,
                  )}`}
                </Chip>
              </span>
            ) : (
              <Button
                type="button"
                variant="secondary"
                icon={<Paperclip size={16} className="text-brand-cyan" />}
                className="w-full justify-center border-dashed"
                onClick={() =>
                  canHostUploadForm() ? void pickHostAttachment() : fileInputRef.current?.click()
                }
              >
                {t("feedbackAttach")}
              </Button>
            )}
            {!canHostUploadForm() && (
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > attachmentMax) {
                    tooLargeToast();
                    return;
                  }
                  setAttachment(file);
                }}
              />
            )}
          </Field>

          {/* rating */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs sm:text-sm font-bold text-text-main mb-1">
              {t("feedbackRatingLabel")}
            </legend>
            <div className="flex items-center justify-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <IconButton
                  key={n}
                  label={`${n} / 5`}
                  variant="ghost"
                  aria-pressed={rating === n}
                  onClick={() => setRating(rating === n ? 0 : n)}
                  icon={
                    <Star
                      size={22}
                      className={n <= rating ? "fill-brand-cyan text-brand-cyan" : "text-muted"}
                    />
                  }
                />
              ))}
            </div>
          </fieldset>

          {/* contact */}
          <Field label={t("feedbackContactLabel")} htmlFor="feedback-contact">
            <Input
              id="feedback-contact"
              type="text"
              maxLength={200}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={t("feedbackContactPlaceholder")}
            />
          </Field>

          {/* diagnostics consent */}
          <div className="flex flex-col gap-2">
            <Checkbox
              id="feedback-diagnostics-consent"
              checked={attachDiagnostics}
              onChange={(e) => setAttachDiagnostics(e.target.checked)}
              label={t("feedbackAttachDiagnostics")}
            />
            {attachDiagnostics && (
              <details
                open={previewOpen}
                onToggle={(e) => setPreviewOpen(e.currentTarget.open)}
                className="group rounded-xl border border-line bg-panel-raised"
              >
                <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-muted select-none hover:text-text-main [&::-webkit-details-marker]:hidden">
                  <span className="flex-1">{t("feedbackDiagnosticsPreview")}</span>
                  {previewLoading ? (
                    <Spinner className="size-3.5 shrink-0 text-muted" />
                  ) : (
                    <ChevronDown
                      size={14}
                      aria-hidden
                      className="shrink-0 transition-transform group-open:rotate-180"
                    />
                  )}
                </summary>
                <div className="border-t border-line px-3 py-2 text-xs">
                  {previewLoading && !previewData ? (
                    <p className="text-muted">{t("feedbackDiagnosticsLoading")}</p>
                  ) : previewData ? (
                    <div className="flex flex-col gap-2">
                      <pre
                        dir="ltr"
                        className="overflow-x-auto rounded-lg bg-panel p-2 font-mono text-[11px] leading-relaxed text-text-main border border-line select-text"
                      >
                        {JSON.stringify(previewData, null, 2)}
                      </pre>
                      <DebugLogPreview debugLog={previewDebugLog} />
                    </div>
                  ) : (
                    <p className="text-muted">{t("feedbackDiagnosticsEmpty")}</p>
                  )}
                </div>
              </details>
            )}
          </div>

          {/* upload progress: a real fraction in the browser, an indeterminate
            bar on the Android host where the native bridge streams the file */}
          {sending && (hostFile || attachment) && (
            <div className="flex flex-col gap-1">
              <div className="h-2 rounded-full bg-line overflow-hidden">
                {hostFile ? (
                  <div className="h-full w-1/3 rounded-full bg-brand-blue animate-pulse" />
                ) : (
                  <div
                    className="h-full rounded-full bg-brand-blue transition-[width]"
                    style={{ width: `${Math.max(4, Math.round((progress ?? 0) * 100))}%` }}
                  />
                )}
              </div>
              <span className="text-[11px] text-muted tabular-nums">
                {t("feedbackSending")}
                {!hostFile && progress !== null && progress > 0
                  ? ` ${Math.round(progress * 100)}%`
                  : "…"}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              {meta?.runtime ? (
                <span className="text-[11px] text-muted">
                  {t("feedbackRuntimeLabel")}: v{meta.runtime.version} · {meta.runtime.platform}
                </span>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={missing > 0}
                loading={sending}
                icon={<Send size={16} />}
                className="w-full sm:w-auto"
              >
                {sending ? t("feedbackSending") : t("feedbackSendBtn")}
              </Button>
            </div>

            {/* what goes with the message: one disclosure, right under Send */}
            <details className="group rounded-xl border border-line bg-panel-raised">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-muted select-none hover:text-text-main [&::-webkit-details-marker]:hidden">
                <Shield size={14} className="shrink-0 text-brand-cyan" />
                <span className="flex-1">{t("feedbackWhatIsSent")}</span>
                <ChevronDown
                  size={14}
                  aria-hidden
                  className="shrink-0 transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="px-3 pb-3 text-xs leading-relaxed text-muted">
                {t("feedbackWhatIsSentDesc")}
              </p>
            </details>

            <p className="text-xs leading-relaxed text-muted">
              {t("feedbackGithubHint")}{" "}
              <a
                href="https://github.com/Abdodiab2005/levix/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-brand-cyan hover:underline"
              >
                {t("feedbackOpenGithub")}
                <ExternalLink size={13} aria-hidden className="shrink-0" />
              </a>
            </p>
          </div>
        </form>
      </Card>
    </div>
  );
};
