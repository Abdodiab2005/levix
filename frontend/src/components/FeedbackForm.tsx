// file: frontend/src/components/FeedbackForm.tsx

import {
  Bug,
  CheckCircle2,
  ExternalLink,
  HeartHandshake,
  Lightbulb,
  Send,
  Shield,
  Sparkles,
  Star,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api, type FeedbackMeta, type FeedbackTopic } from "../api/client";
import { useToast } from "./Toasts";
import { useI18n } from "../context/I18nContext";
import { cn } from "../utils/cn";

/**
 * The panel's line to the developer, and the app's answer to Google Play's
 * expectation that a user can reach whoever built it. The bot forwards what is
 * written here to levix.leviro.net/api/feedback from the server side, so this
 * form never talks to anything but the panel it is already signed in to.
 *
 * The limits below are re-checked by the backend (src/panel/feedback.cjs); they
 * are here to answer the operator immediately, not to be trusted.
 */

const FALLBACK = { messageMin: 10, messageMax: 2000 };

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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

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
  const trimmed = message.trim();
  const missing = Math.max(0, messageMin - trimmed.length);

  const topics = (meta?.topics?.length ? meta.topics : TOPIC_ORDER).filter(
    (id) => id in TOPIC_META,
  );

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (missing > 0 || sending) return;

    setSending(true);
    try {
      await api.sendFeedback({
        message: trimmed,
        topic,
        rating: rating || null,
        contact: contact.trim() || null,
      });
      setSent(true);
      toast(t("feedbackSent"), "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setMessage("");
    setContact("");
    setRating(0);
    setTopic("bug");
    setSent(false);
  };

  if (sent) {
    return (
      <div className="rounded-2xl border border-ok/30 bg-panel p-6 sm:p-8 text-center shadow-sm">
        <div className="mx-auto w-12 h-12 rounded-full bg-ok/10 text-ok flex items-center justify-center">
          <CheckCircle2 size={26} />
        </div>
        <h3 className="mt-4 text-lg font-bold text-text-main">{t("feedbackSent")}</h3>
        <p className="mt-2 mx-auto max-w-md text-xs sm:text-sm text-muted leading-relaxed">
          {t("feedbackSentDesc")}
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex items-center justify-center px-4 h-11 rounded-xl border border-line bg-panel-raised text-text-main font-bold text-xs sm:text-sm hover:bg-panel-hover transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
        >
          {t("feedbackSendAnother")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={handleSend}
        className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5"
      >
        <div className="flex items-center gap-3 pb-4 border-b border-line">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
            <Send size={20} />
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-bold text-text-main">{t("feedbackTitle")}</h3>
            <p className="text-xs sm:text-sm text-muted mt-0.5">{t("feedbackDesc")}</p>
          </div>
        </div>

        {/* topic */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs sm:text-sm font-bold text-text-main mb-2">
            {t("feedbackTopicLabel")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {topics.map((id) => {
              const Icon = TOPIC_META[id].icon;
              const active = topic === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTopic(id)}
                  className={cn(
                    "inline-flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl border font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
                    active
                      ? "bg-brand-blue text-white border-brand-blue shadow-md shadow-brand-blue/20"
                      : "bg-panel-raised border-line text-muted hover:text-text-main hover:bg-panel-hover",
                  )}
                >
                  <Icon size={16} className="shrink-0" />
                  <span>{t(TOPIC_META[id].labelKey)}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* message */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="feedback-message" className="text-xs sm:text-sm font-bold text-text-main">
            {t("feedbackMessageLabel")}
          </label>
          <textarea
            id="feedback-message"
            rows={6}
            required
            maxLength={messageMax}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("feedbackMessagePlaceholder")}
            className="w-full resize-y px-3.5 py-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          />
          <span className="self-end text-[11px] text-muted tabular-nums">
            {missing > 0
              ? `${missing} ${t("feedbackCharsNeeded")}`
              : `${message.length} / ${messageMax}`}
          </span>
        </div>

        {/* rating */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs sm:text-sm font-bold text-text-main mb-1">
            {t("feedbackRatingLabel")}
          </legend>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} / 5`}
                aria-pressed={rating === n}
                onClick={() => setRating(rating === n ? 0 : n)}
                className="p-2 rounded-lg hover:bg-panel-hover transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
              >
                <Star
                  size={22}
                  className={cn(
                    "transition-colors",
                    n <= rating ? "fill-brand-cyan text-brand-cyan" : "text-muted",
                  )}
                />
              </button>
            ))}
          </div>
        </fieldset>

        {/* contact */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="feedback-contact" className="text-xs sm:text-sm font-bold text-text-main">
            {t("feedbackContactLabel")}
          </label>
          <input
            id="feedback-contact"
            type="text"
            maxLength={200}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder={t("feedbackContactPlaceholder")}
            className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
          {meta?.runtime ? (
            <span className="text-[11px] text-muted">
              {t("feedbackRuntimeLabel")}: v{meta.runtime.version} · {meta.runtime.platform}
            </span>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={missing > 0 || sending}
            className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm transition-all shadow-md shadow-brand-blue/20 focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={16} />
            <span>{sending ? t("feedbackSending") : t("feedbackSendBtn")}</span>
          </button>
        </div>
      </form>

      {/* what travels with it */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <Shield size={16} className="text-brand-cyan shrink-0" />
          <h4 className="text-xs sm:text-sm font-bold text-text-main">{t("feedbackWhatIsSent")}</h4>
        </div>
        <p className="text-xs sm:text-sm text-muted leading-relaxed">
          {t("feedbackWhatIsSentDesc")}
        </p>
        <div className="pt-2 border-t border-line flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span className="text-xs text-muted leading-relaxed">{t("feedbackGithubHint")}</span>
          <a
            href="https://github.com/Abdodiab2005/levix/issues"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-cyan hover:underline whitespace-nowrap"
          >
            {t("feedbackOpenGithub")}
            <ExternalLink size={13} />
          </a>
        </div>
      </div>
    </div>
  );
};
