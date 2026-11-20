// file: frontend/src/views/ConnectedAccountCard.tsx

import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Play,
  Radio,
  RefreshCw,
  Settings2,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  Avatar,
  Button,
  Card,
  CodeText,
  IconButton,
  Skeleton,
  Spinner,
  StatusPill,
  UserText,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";
import {
  canDisplaySavedProfile,
  mapSessionToCard,
  normalizeAccountId,
  shouldClearSavedProfile,
} from "../utils/accountCardState";
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

type SavedEntry = {
  accountId: string | null;
  phone: string | null;
  fetchKey: string;
  profile: Profile;
};

interface ConnectedAccountCardProps {
  status: SessionStatus | null;
  /** `compact` is the Overview card; `expanded` is the Connection card. */
  variant?: "compact" | "expanded" | "full";
  /** Overview only. Navigates to the Connection screen; it never touches the session. */
  onManage?: () => void;
  /** Overview only. Starts a linked session directly from the compact card. */
  onStart?: () => void;
  /** True while the session start request is in flight. */
  starting?: boolean;
}

const ACTION_ICON = {
  manage: <Settings2 size={16} />,
  connect: <Play size={16} />,
  reconnect: <RefreshCw size={16} />,
} as const;

function cleanUserName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "~") return null;
  return trimmed;
}

export function ConnectedAccountCard({
  status,
  variant = "expanded",
  onManage,
  onStart,
  starting = false,
}: ConnectedAccountCardProps) {
  const { t } = useI18n();
  const card = mapSessionToCard(status);
  const connected = status?.state === "connected" && status.connected !== false;
  const accountId = normalizeAccountId(status?.user?.id);
  const identity = connected ? `${accountId || "connected"}|${status?.since ?? ""}` : "";
  const [saved, setSaved] = useState<SavedEntry | null>(null);
  const [settledIdentity, setSettledIdentity] = useState<string>("");
  const [revealedAccount, setRevealedAccount] = useState<string | null>(null);

  const clearSaved = shouldClearSavedProfile(status, saved);
  const retained = clearSaved ? null : saved;
  const numberVisible = Boolean(
    (status?.user?.id && revealedAccount === status.user.id) ||
      (retained?.accountId && revealedAccount === retained.accountId),
  );

  useEffect(() => {
    if (clearSaved && saved) {
      setSaved(null);
      setSettledIdentity("");
      setRevealedAccount(null);
    }
  }, [clearSaved, saved]);

  useEffect(() => {
    if (status?.state !== "connected" && !canDisplaySavedProfile(status, saved)) {
      setRevealedAccount(null);
    }
  }, [status, saved]);

  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const incoming = result.profile;
        if (incoming.connected) {
          setSaved((prev) => {
            if (prev?.phone && incoming.phone && prev.phone !== incoming.phone) {
              setRevealedAccount(null);
            }
            return {
              accountId: accountId ?? prev?.accountId ?? null,
              phone: incoming.phone ?? null,
              fetchKey: identity,
              profile: incoming,
            };
          });
        }
        setSettledIdentity(identity);
        const wait = Math.max(0, Math.min(10_000, incoming.refreshAfterMs || 0));
        if (timer.current) clearTimeout(timer.current);
        setCooldown(wait > 0);
        if (wait) timer.current = setTimeout(() => setCooldown(false), wait);
      } catch {
        if (generation === request.current) {
          setSettledIdentity(identity);
        }
      } finally {
        if (generation === request.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [identity, accountId],
  );

  useEffect(() => {
    request.current += 1;
    busy.current = false;
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

  const canShowProfile = canDisplaySavedProfile(status, retained);
  const visible = canShowProfile && retained?.profile.connected ? retained.profile : null;
  const displayName = visible?.name || (connected ? cleanUserName(status?.user?.name) : null);
  const fetchPending = Boolean(connected && identity && settledIdentity !== identity);
  const isFetching = loading || fetchPending;
  const hasAnyProfileData = Boolean(
    displayName || visible?.phone || visible?.about || visible?.photoUrl,
  );
  /** Connected and fetch settled, but no profile fields could be read. */
  const profileUnavailable = card.showProfile && !hasAnyProfileData && !isFetching;

  const attemptText =
    card.attempt !== null && card.maxAttempts !== null
      ? fill(t("accountCardAttempt"), { attempt: card.attempt, max: card.maxAttempts })
      : null;

  const stateIcon =
    card.tone === "ok" ? (
      <CheckCircle2 size={14} className="shrink-0 text-ok" aria-label={t(card.labelKey)} />
    ) : card.tone === "danger" || card.tone === "warn" ? (
      <AlertCircle
        size={14}
        className={card.tone === "danger" ? "shrink-0 text-danger" : "shrink-0 text-warn"}
        aria-label={t(card.labelKey)}
      />
    ) : (
      <Radio size={14} className="shrink-0 text-muted" aria-label={t(card.labelKey)} />
    );

  const statusLine = card.loading ? null : (
    <span className="inline-flex items-center gap-1.5">
      {stateIcon}
      <StatusPill tone={card.tone} dot pulse={card.pulsing}>
        {t(card.labelKey)}
      </StatusPill>
    </span>
  );

  const fallbackName = t("accountCardTitle");
  const revealTarget = status?.user?.id || retained?.accountId || null;

  const headerBlock = (
    <div className="flex min-w-0 items-start gap-3">
      {card.loading ? (
        <Skeleton className="size-12 shrink-0 rounded-xl" />
      ) : (
        <Avatar
          key={visible?.photoUrl || accountId || identity || "none"}
          src={visible?.photoUrl || undefined}
          name={displayName || ""}
          icon={<Smartphone size={22} />}
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
            {displayName ? (
              <UserText lines={2} className="text-sm font-bold text-text-main">
                {displayName}
              </UserText>
            ) : (
              <p className="text-sm font-bold text-text-main">{fallbackName}</p>
            )}
            {visible?.phone ? (
              <div className="flex items-center gap-1.5">
                <CodeText className="text-xs text-muted">
                  {numberVisible ? visible.phone : "••• ••• ••••"}
                </CodeText>
                <IconButton
                  label={numberVisible ? t("hideNumber") : t("showNumber")}
                  pressed={numberVisible}
                  variant="ghost"
                  size="sm"
                  icon={numberVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  onClick={() => setRevealedAccount(numberVisible ? null : revealTarget)}
                />
              </div>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {statusLine}
          {attemptText && <span className="text-xs text-muted">{attemptText}</span>}
          {loading && <Spinner label={t("loading")} />}
        </div>
      </div>
      {variant !== "compact" && connected && (
        <IconButton
          label={cooldown ? t("accountProfileRefreshSoon") : t("accountProfileRefresh")}
          icon={<RefreshCw size={18} />}
          disabled={loading || cooldown}
          onClick={() => void load(true)}
        />
      )}
    </div>
  );

  if (variant === "compact") {
    const isStartable = Boolean(
      status && ["idle", "disconnected", "retry_exhausted", "error"].includes(status.state),
    );
    const isLinked = Boolean(status?.user?.id || status?.linked);
    const canStart = Boolean(onStart && isStartable && isLinked);
    return (
      <Card className="flex flex-col gap-3">
        {headerBlock}
        {profileUnavailable ? (
          <p role="status" className="text-xs text-muted">
            {t("accountCardProfileUnavailable")}
          </p>
        ) : null}
        {onManage || canStart ? (
          <div className="flex flex-wrap items-center gap-2">
            {canStart ? (
              <Button
                variant="primary"
                icon={<Play size={16} />}
                onClick={onStart}
                loading={starting}
              >
                {t("start")}
              </Button>
            ) : null}
            {onManage ? (
              <Button
                variant={card.tone === "ok" || canStart ? "secondary" : "primary"}
                icon={canStart ? ACTION_ICON.manage : ACTION_ICON[card.action]}
                onClick={onManage}
              >
                {t("accountCardManageSession")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      {headerBlock}
      {visible?.about ? (
        <div className="border-t border-line pt-2.5">
          <UserText as="bdi" dir="auto" lines={2} className="text-xs text-muted">
            {visible.about}
          </UserText>
        </div>
      ) : null}
      {!connected && !visible ? (
        <p className="text-xs text-muted">{t("accountProfileDisconnected")}</p>
      ) : profileUnavailable ? (
        <p role="status" className="text-xs text-muted">
          {t("accountProfileUnavailable")}
        </p>
      ) : null}
    </Card>
  );
}
