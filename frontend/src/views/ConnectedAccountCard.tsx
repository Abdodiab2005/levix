// file: frontend/src/views/ConnectedAccountCard.tsx

import { Play, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  IconButton,
  Skeleton,
  Spinner,
  StatusPill,
  UserText,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";
import { mapSessionToCard } from "../utils/accountCardState";
import { fill } from "../utils/fill";

type Profile = {
  connected: boolean;
  name: string | null;
  phone: string | null;
  about: string | null;
  photoUrl: string | null;
  revision: string | null;
  refreshAfterMs: number;
};

interface ConnectedAccountCardProps {
  status: SessionStatus | null;
  /** `compact` is the Home card: avatar, name, phone, one status line. */
  variant?: "full" | "compact";
  /** Home only. Navigates to the Connection screen; it never touches the session. */
  onManage?: () => void;
}

const ACTION_ICON = {
  manage: <Settings2 size={16} />,
  connect: <Play size={16} />,
  reconnect: <RefreshCw size={16} />,
} as const;

export function ConnectedAccountCard({
  status,
  variant = "full",
  onManage,
}: ConnectedAccountCardProps) {
  const { t } = useI18n();
  const card = mapSessionToCard(status);
  const connected = status?.state === "connected" && status.connected !== false;
  const identity = connected ? `${status?.user?.id || "connected"}|${status?.since ?? ""}` : "";
  const [saved, setSaved] = useState<{ identity: string; profile: Profile } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Never paint the previous account while an identity-change effect is pending.
  const profile = connected && saved?.identity === identity ? saved.profile : null;

  const load = useCallback(
    async (refresh: boolean) => {
      if (!identity || busy.current) return;
      const generation = ++request.current;
      busy.current = true;
      setLoading(true);
      try {
        const result = refresh
          ? await api.post<{ profile: Profile }>("/account/profile/refresh", {})
          : await api.get<{ profile: Profile }>("/account/profile");
        if (generation !== request.current) return;
        setSaved({ identity, profile: result.profile });
        const wait = Math.max(0, Math.min(10_000, result.profile.refreshAfterMs || 0));
        if (timer.current) clearTimeout(timer.current);
        setCooldown(wait > 0);
        if (wait) timer.current = setTimeout(() => setCooldown(false), wait);
      } catch {
        // The status line stays; the unavailable note below covers the gap.
      } finally {
        if (generation === request.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [identity],
  );

  useEffect(() => {
    request.current += 1;
    busy.current = false;
    setSaved(null);
    setLoading(false);
    setCooldown(false);
    if (timer.current) clearTimeout(timer.current);
    if (identity) void load(false);
    return () => {
      request.current += 1;
      busy.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [identity, load]);

  const visible = card.showProfile && profile?.connected ? profile : null;
  /** Connected, but the panel could not read the profile: say so, never invent one. */
  const profileUnavailable = card.showProfile && !visible && !loading;
  const attemptText =
    card.attempt !== null && card.maxAttempts !== null
      ? fill(t("accountCardAttempt"), { attempt: card.attempt, max: card.maxAttempts })
      : null;
  const statusLine = card.loading ? null : (
    <StatusPill tone={card.tone} dot pulse={card.pulsing}>
      {t(card.labelKey)}
    </StatusPill>
  );

  if (variant === "compact") {
    const fallbackName = t("accountCardTitle");
    return (
      <Card className="flex flex-col gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {card.loading ? (
            <Skeleton className="size-12 shrink-0 rounded-xl" />
          ) : (
            <Avatar
              key={visible?.photoUrl || identity || "none"}
              src={visible?.photoUrl || undefined}
              name={visible?.name || fallbackName}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {card.loading ? (
              <>
                <Skeleton className="h-4 w-32 max-w-full" />
                <Skeleton className="h-3 w-24 max-w-full" />
              </>
            ) : (
              <>
                {visible?.name ? (
                  <UserText lines={2} className="text-sm font-bold text-text-main">
                    {visible.name}
                  </UserText>
                ) : null}
                {visible?.phone ? (
                  <UserText as="bdi" dir="ltr" className="text-xs text-muted">
                    {visible.phone}
                  </UserText>
                ) : null}
              </>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {statusLine}
              {attemptText && <span className="text-xs text-muted">{attemptText}</span>}
              {loading && <Spinner label={t("loading")} />}
            </div>
          </div>
        </div>
        {profileUnavailable ? (
          <p role="status" className="text-xs text-muted">
            {t("accountCardProfileUnavailable")}
          </p>
        ) : null}
        {onManage ? (
          <Button
            variant={card.tone === "ok" ? "secondary" : "primary"}
            icon={ACTION_ICON[card.action]}
            onClick={onManage}
            className="w-full sm:w-auto sm:self-start"
          >
            {t("accountCardManageSession")}
          </Button>
        ) : null}
      </Card>
    );
  }

  const fields = [
    ["accountProfileName", visible?.name],
    ["accountProfilePhone", visible?.phone],
    ["accountProfileAbout", visible?.about],
  ] as const;

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title={t("accountCardTitle")}
        actions={
          <IconButton
            label={cooldown ? t("accountProfileRefreshSoon") : t("accountProfileRefresh")}
            icon={<RefreshCw size={18} />}
            disabled={!connected || loading || cooldown}
            onClick={() => void load(true)}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Avatar
          key={visible?.photoUrl || identity || "none"}
          src={visible?.photoUrl || undefined}
          name={visible?.name || t("accountCardTitle")}
        />
        {statusLine}
        {attemptText && <span className="text-xs text-muted">{attemptText}</span>}
        {loading && <Spinner label={t("loading")} />}
      </div>
      {!connected ? (
        <p className="text-sm text-muted">{t("accountProfileDisconnected")}</p>
      ) : (
        <>
          {profileUnavailable && (
            <p role="status" className="text-sm text-muted">
              {t("accountProfileUnavailable")}
            </p>
          )}
          <dl className="grid gap-3 sm:grid-cols-2">
            {fields.map(([label, value]) => (
              <div
                key={label}
                className={`flex min-w-0 flex-col gap-1 ${label === "accountProfileAbout" ? "sm:col-span-2" : ""}`}
              >
                <dt className="text-xs text-muted">{t(label)}</dt>
                <dd className="min-w-0">
                  <UserText
                    as="bdi"
                    dir={label === "accountProfilePhone" && value ? "ltr" : "auto"}
                  >
                    {value || t("accountProfileMissing")}
                  </UserText>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}
