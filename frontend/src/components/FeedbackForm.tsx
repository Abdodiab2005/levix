// file: frontend/src/components/FeedbackForm.tsx

import {
  Bug,
  CheckCircle2,
  ExternalLink,
  HeartHandshake,
  Lightbulb,
  Paperclip,
  Send,
  Shield,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api, type FeedbackMeta, type FeedbackTopic } from "../api/client";
import { useI18n } from "../context/I18nContext";
import type { HostSource } from "../utils/hostBridge";
import { canHostUploadForm, pickHostFile, uploadHostForm } from "../utils/hostBridge";
import { useToast } from "./Toasts";
import { Button, Card, Field, IconButton, Input, Tabs, Textarea } from "./ui";

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
  const { t } = useI18n();
  const { toast } = useToast();

  const [meta, setMeta] = useState<FeedbackMeta | null>(null);
  const [topic, setTopic] = useState<FeedbackTopic>("bug");
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(0);
  const [contact, setContact] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [hostFile, setHostFile] = useState<HostSource | null>(null);
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

  const messageMin = meta?.messageMin ?? FALLBACK.messageMin;
  const messageMax = meta?.messageMax ?? FALLBACK.messageMax;
  const attachmentMax = meta?.attachmentMax ?? FALLBACK.attachmentMax;
  const attachmentMaxMb = Math.round(attachmentMax / (1024 * 1024));
  const trimmed = message.trim();
  const missing = Math.max(0, messageMin - trimmed.length);

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
    const payload = {
      message: trimmed,
      topic,
      rating: rating || null,
      contact: contact.trim() || null,
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
              className="flex-wrap"
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

          {/* attachment */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs sm:text-sm font-bold text-text-main">
              {t("feedbackAttach")}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {hostFile || attachment ? (
                <span className="inline-flex items-center gap-2 ps-3 pe-2 h-10 rounded-xl border border-line bg-panel-raised text-xs sm:text-sm text-text-main max-w-full">
                  <Paperclip size={14} className="text-brand-cyan shrink-0" />
                  <span className="truncate max-w-[200px]">
                    {hostFile?.name ?? attachment?.name}
                  </span>
                  <IconButton
                    label={t("feedbackRemoveAttachment")}
                    variant="ghost"
                    icon={<X size={16} />}
                    onClick={clearAttachment}
                  />
                </span>
              ) : (
                <Button
                  size="sm"
                  icon={<Paperclip size={16} className="text-brand-cyan" />}
                  onClick={() =>
                    canHostUploadForm() ? void pickHostAttachment() : fileInputRef.current?.click()
                  }
                >
                  {t("feedbackAttach")}
                </Button>
              )}
              <span className="text-[11px] text-muted">
                {t("feedbackAttachmentHint").replace("{max}", String(attachmentMaxMb))}
              </span>
            </div>
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
          </div>

          {/* rating */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs sm:text-sm font-bold text-text-main mb-1">
              {t("feedbackRatingLabel")}
            </legend>
            <div className="flex items-center gap-1">
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

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
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
            >
              {sending ? t("feedbackSending") : t("feedbackSendBtn")}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <Shield size={16} className="text-brand-cyan shrink-0" />
          <h4 className="text-xs sm:text-sm font-bold text-text-main">{t("feedbackWhatIsSent")}</h4>
        </div>
        <p className="text-xs sm:text-sm text-muted leading-relaxed">
          {t("feedbackWhatIsSentDesc")}
        </p>
        <div className="pt-2 border-t border-line flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span className="text-xs text-muted leading-relaxed">{t("feedbackGithubHint")}</span>
          <IconButton
            label={t("feedbackOpenGithub")}
            variant="ghost"
            icon={<ExternalLink size={16} />}
            onClick={() =>
              window.open(
                "https://github.com/Abdodiab2005/levix/issues",
                "_blank",
                "noopener,noreferrer",
              )
            }
          />
        </div>
      </Card>
    </div>
  );
};
