import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  Avatar,
  Card,
  CardHeader,
  IconButton,
  Spinner,
  StatusPill,
  UserText,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";

type Profile = {
  connected: boolean;
  name: string | null;
  phone: string | null;
  about: string | null;
  photoUrl: string | null;
  revision: string | null;
  refreshAfterMs: number;
};

export function ConnectedAccountCard({ status }: { status: SessionStatus | null }) {
  const { t } = useI18n();
  const connected = status?.state === "connected" && status.connected !== false;
  const identity = connected ? `${status?.user?.id || "connected"}|${status?.since ?? ""}` : "";
  const [saved, setSaved] = useState<{ identity: string; profile: Profile } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
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
      setFailed(false);
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
        if (generation === request.current) setFailed(true);
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
    setFailed(false);
    setCooldown(false);
    if (timer.current) clearTimeout(timer.current);
    if (identity) void load(false);
    return () => {
      request.current += 1;
      busy.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [identity, load]);

  const visible = profile?.connected ? profile : null;
  const name = visible?.name || t("accountProfileMissing");
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
      <div className="flex items-center gap-3">
        <Avatar
          key={visible?.photoUrl || identity}
          src={visible?.photoUrl || undefined}
          name={name}
        />
        <StatusPill tone={connected && profile?.connected !== false ? "ok" : "neutral"} dot>
          {connected && profile?.connected !== false ? t("connected") : t("disconnected")}
        </StatusPill>
        {loading && <Spinner label={t("loading")} />}
      </div>
      {!connected ? (
        <p className="text-sm text-muted">{t("accountProfileDisconnected")}</p>
      ) : (
        <>
          {failed && (
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
                <dd>
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
