import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { fill } from "../utils/fill";
import {
  nativeInstallChannel,
  nativeUpdatePending,
  playUpdate,
  reviewPromptsEnabled,
  setReviewPromptsEnabled,
  type PlayUpdateStatus,
} from "../utils/hostBridge";
import { officialLinks, openOfficialLink, safeOfficialUrl } from "../utils/officialLinks";
import { Button, Card, CardHeader, IconButton, Toggle, UserText } from "./ui";

type Update = {
  channel: "play" | "github";
  status: "idle" | "available" | "up_to_date" | "unavailable" | "play";
  currentVersion: string;
  latestVersion?: string | null;
  url: string;
  releaseNotes?: string;
};

export function AboutPanel() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<Update | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [playStatus, setPlayStatus] = useState<PlayUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(reviewPromptsEnabled);
  const [linkError, setLinkError] = useState(false);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const checking = useRef(false);
  const queuedNativeRefresh = useRef(false);
  const channel = nativeInstallChannel() || update?.channel || "github";

  useEffect(() => {
    mounted.current = true;
    const initialRequest = requestId.current;
    // Local metadata only. Opening About never starts a remote update check.
    api
      .get<{ update: Update }>("/updates")
      .then((res) => {
        if (mounted.current) setCurrentVersion(res.update.currentVersion);
        if (mounted.current && requestId.current === initialRequest) setUpdate(res.update);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setEnabled(reviewPromptsEnabled());
    window.addEventListener("levix-review-prefs", refresh);
    return () => window.removeEventListener("levix-review-prefs", refresh);
  }, []);

  const check = useCallback(
    async function runCheck(action: "check" | "start" | "complete" = "check", automatic = false) {
      if (checking.current) {
        if (automatic) queuedNativeRefresh.current = true;
        return;
      }
      checking.current = true;
      requestId.current += 1;
      setBusy(true);
      try {
        if (channel === "play") {
          const result = await playUpdate(action);
          if (!mounted.current) return;
          setPlayStatus(
            result.ok
              ? result.status || "unavailable"
              : result.cancelled
                ? "cancelled"
                : "unavailable",
          );
          if (!automatic && action === "check" && result.ok && result.status === "up_to_date") {
            // Optional opportunity after a completed action; the Rate link never calls Review.
            void playUpdate("review");
          }
        } else {
          const res = await api.post<{ update: Update }>("/updates/check", {});
          if (mounted.current) setUpdate(res.update);
        }
      } catch {
        if (mounted.current) {
          if (channel === "play") setPlayStatus("unavailable");
          else
            setUpdate((old) => ({
              channel: "github",
              currentVersion: old?.currentVersion || "",
              url: officialLinks.releases,
              status: "unavailable",
            }));
        }
      } finally {
        checking.current = false;
        if (mounted.current) setBusy(false);
        if (mounted.current && queuedNativeRefresh.current) {
          queuedNativeRefresh.current = false;
          void runCheck("check", true);
        }
      }
    },
    [channel],
  );

  useEffect(() => {
    // Recover a download the operator already started, including a completion
    // event received before React mounted. New installs never check on mount.
    if (nativeInstallChannel() === "play" && nativeUpdatePending()) void check("check", true);
  }, [check]);

  useEffect(() => {
    // A native download may complete while this panel is open. No polling.
    const onUpdate = () => {
      void check("check", true);
    };
    window.addEventListener("levix-play-update", onUpdate);
    return () => window.removeEventListener("levix-play-update", onUpdate);
  }, [check]);

  function open(url: string) {
    setLinkError(!openOfficialLink(url));
  }
  const links = [
    ["officialDocs", officialLinks.docs],
    ["officialWebsite", officialLinks.website],
    ["officialSupport", officialLinks.support],
    ["officialPortfolio", officialLinks.portfolio],
    ["officialStudio", officialLinks.studio],
  ] as const;
  const status = channel === "play" ? playStatus || "idle" : update?.status || "idle";
  const statusText = {
    idle: t("updateIdle"),
    available:
      channel === "play"
        ? t("updateAvailablePlay")
        : fill(t("updateAvailable"), { version: update?.latestVersion || "" }),
    up_to_date: t("updateCurrent"),
    unavailable: t("updateUnavailable"),
    play: t("updateIdle"),
    downloading: t("updateDownloading"),
    downloaded: t("updateDownloaded"),
    started: t("updateDownloading"),
    cancelled: t("updateCancelled"),
  }[status];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <CardHeader title={t("aboutLevix")} description={t("aboutLevixDesc")} />
        <p className="text-sm text-muted">{t("aboutCredit")}</p>
        <div className="flex flex-col gap-2">
          {links.map(([label, url]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span>{t(label)}</span>
              <IconButton
                label={t(label)}
                icon={<ExternalLink size={18} />}
                onClick={() => open(url)}
              />
            </div>
          ))}
        </div>
        {linkError && (
          <p role="alert" className="text-sm text-danger">
            {t("officialLinkUnavailable")}
          </p>
        )}
      </Card>
      <Card className="flex flex-col gap-4">
        <CardHeader
          title={t("updatesTitle")}
          actions={
            <IconButton
              label={t("checkUpdates")}
              disabled={busy}
              icon={<RefreshCw size={18} />}
              onClick={() => void check()}
            />
          }
        />
        <p className="text-sm text-muted">
          {t("currentVersion")}:{" "}
          <bdi dir="ltr">{currentVersion || update?.currentVersion || "—"}</bdi>
        </p>
        <p role="status" aria-live="polite">
          {busy ? t("updateChecking") : statusText}
        </p>
        <p className="text-sm text-muted">
          {channel === "play" ? t("updatePlayHint") : t("updateGithubHint")}
        </p>
        {channel === "play" && status === "available" && (
          <Button variant="primary" loading={busy} onClick={() => void check("start")}>
            {t("updateStart")}
          </Button>
        )}
        {channel === "play" && status === "downloaded" && (
          <Button variant="primary" loading={busy} onClick={() => void check("complete")}>
            {t("updateComplete")}
          </Button>
        )}
        {channel === "github" && update?.status === "available" && safeOfficialUrl(update.url) && (
          <Button onClick={() => open(update.url)}>{t("updateRelease")}</Button>
        )}
        {update?.releaseNotes && (
          <div className="flex flex-col gap-2">
            <h3 className="font-bold">{t("updateNotes")}</h3>
            <UserText className="whitespace-pre-wrap break-words text-sm text-muted">
              {update.releaseNotes}
            </UserText>
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-4">
        <CardHeader title={t("supportLevix")} description={t("supportLevixDesc")} />
        <div className="flex items-center justify-between gap-3">
          <span>{channel === "play" ? t("rateLevix") : t("starGithub")}</span>
          <IconButton
            label={channel === "play" ? t("rateLevix") : t("starGithub")}
            icon={<ExternalLink size={18} />}
            onClick={() => open(channel === "play" ? officialLinks.play : officialLinks.github)}
          />
        </div>
        {channel === "play" && (
          <Toggle
            checked={enabled}
            label={t("reviewPrompts")}
            description={t("reviewPromptsDesc")}
            onChange={(value) => {
              if (setReviewPromptsEnabled(value)) setEnabled(value);
            }}
          />
        )}
      </Card>
    </div>
  );
}
