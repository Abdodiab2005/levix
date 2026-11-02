import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { Button, Checkbox, Dialog, Spinner } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { LegalPart, LegalTermsResponse, SessionStatus } from "../../types";
import { fill } from "../../utils/fill";

export function consentReasonText(
  reason: string | null | undefined,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (reason) {
    case "terms_changed":
      return t("legalReasonChanged");
    case "app_updated":
      return t("legalReasonUpdated");
    case "consent_unreadable":
      return t("legalReasonUnreadable");
    default:
      return t("legalReasonNotAccepted");
  }
}

function DocumentPart({ part }: { part: LegalPart }) {
  return (
    <section className="space-y-3">
      <h3 dir="auto" className="text-base font-bold text-text-main">{part.title}</h3>
      {part.sections.map((section, index) => (
        <div key={index} className="space-y-2">
          <h4 dir="auto" className="text-sm font-semibold text-text-main">{section.heading}</h4>
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p
              key={paragraphIndex}
              dir="auto"
              className="text-sm leading-relaxed text-muted whitespace-pre-wrap"
            >
              {paragraph}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

interface TermsConsentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAccepted: (session: SessionStatus) => void;
}

export function TermsConsentDialog({
  isOpen,
  onClose,
  onAccepted,
}: TermsConsentDialogProps) {
  const { language, t } = useI18n();
  const [document, setDocument] = useState<LegalTermsResponse | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const savingRef = useRef(false);

  const loadTerms = useCallback(() => {
    const request = ++requestId.current;
    if (!savingRef.current) setDocument(null);
    setChecked(false);
    setChanged(false);
    setError(null);
    setLoading(true);
    api
      .getLegalTerms(language)
      .then((result) => {
        if (request === requestId.current && !savingRef.current) setDocument(result);
      })
      .catch(() => {
        if (request === requestId.current && !savingRef.current) setError(t("legalLoadError"));
      })
      .finally(() => {
        if (request === requestId.current) setLoading(false);
      });
  }, [language, t]);

  useEffect(() => {
    if (!isOpen) return;
    loadTerms();
    return () => {
      requestId.current++;
    };
  }, [isOpen, loadTerms]);

  const accept = async () => {
    if (!document || !checked || saving) return;
    requestId.current++;
    savingRef.current = true;
    setSaving(true);
    setLoading(false);
    setError(null);
    try {
      const result = await api.acceptLegalTerms({
        version: document.version,
        sha256: document.sha256,
        locale: document.locale,
      });
      onAccepted(result.session);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "TERMS_CHANGED") {
        setDocument(cause.data as LegalTermsResponse);
        setChecked(false);
        setChanged(true);
      } else {
        setError(t("legalAcceptError"));
      }
    } finally {
      requestId.current++;
      savingRef.current = false;
      setLoading(false);
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("legalConsentTitle")}
      maxWidth="44rem"
      footer={
        <div className="flex w-full flex-col items-end gap-2">
          <Button
            variant="primary"
            onClick={accept}
            disabled={!document || !checked || saving}
            loading={saving}
          >
            {t("legalAccept")}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      }
    >
      {loading ? <Spinner label={t("loading")} /> : null}
      {!loading && !document && error && (
        <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={loadTerms}>
          {t("retry")}
        </Button>
      )}
      {!loading && document && (
        <div className="space-y-4">
          <p className="text-sm text-text-main" role={changed ? "alert" : undefined}>
            {changed
              ? t("legalChangedReview")
              : consentReasonText(document.consent.reason, t)}
          </p>
          {document.locale !== language && (
            <p className="text-sm text-muted">{t("legalEnglishFallback")}</p>
          )}
          <p className="text-xs text-muted">
            {fill(t("legalVersionEffective"), {
              version: document.version,
              date: document.effective,
            })}
          </p>
          <div
            lang={document.locale}
            dir={document.locale === "ar" ? "rtl" : "ltr"}
            className="max-h-[50dvh] space-y-6 overflow-y-auto rounded-xl border border-line bg-panel-raised p-4"
          >
            <DocumentPart part={document.terms} />
            <DocumentPart part={document.privacy} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {([
              ["privacyPolicy", "legalFullPrivacy"],
              ["license", "legalLicense"],
              ["website", "legalWebsite"],
            ] as const).map(([key, label]) => (
              <a
                key={key}
                href={document.links[key]}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center text-sm text-brand-blue underline"
              >
                {t(label)}
              </a>
            ))}
          </div>
          <Checkbox
            label={t("legalReadAccept")}
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
        </div>
      )}
    </Dialog>
  );
}
