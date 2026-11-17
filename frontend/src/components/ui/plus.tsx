// file: frontend/src/components/ui/plus.tsx
import { Lock } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import { useI18n } from "../../context/I18nContext";
import { usePlusStatus } from "../../hooks/usePlusStatus";
import { cn } from "../../utils/cn";
import { accessFromStatus, type PlusFeatureTab, plusHash } from "../../utils/plusAccess";
import { Button, LinkButton } from "./button";
import { Card } from "./card";

/** Vector crown. Takes the colour of the text around it. Decorative: pair it with text. */
export function CrownIcon({
  size = 16,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<"svg">, "width" | "height"> & { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M3 7.5l4.6 4.1L12 4.5l4.4 7.1L21 7.5l-1.7 9H4.7z" />
      <rect x="5" y="18.2" width="14" height="2.3" rx="1.15" />
    </svg>
  );
}

const PLUS_BADGE = {
  base: "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold",
  tone: {
    // Solid surface, so it stays readable on a selected (filled) nav item too.
    active: "border-brand-purple/40 bg-panel-raised text-text-main",
    muted: "border-line bg-panel-raised text-muted",
  },
  crown: {
    active: "text-brand-purple",
    muted: "text-faint",
  },
} as const;

export interface PlusBadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: keyof typeof PLUS_BADGE.tone;
  /** Show the crown before the text. */
  crown?: boolean;
}

/** A pill that always carries text. The crown is decoration. */
export function PlusBadge({
  tone = "active",
  crown = false,
  className,
  children,
  ...props
}: PlusBadgeProps) {
  return (
    <span className={cn(PLUS_BADGE.base, PLUS_BADGE.tone[tone], className)} {...props}>
      {crown && <CrownIcon size={12} className={PLUS_BADGE.crown[tone]} />}
      {children}
    </span>
  );
}

export interface PlusFeatureRowProps {
  /** The feature, already translated. */
  title: ReactNode;
  /** One line saying what the feature does, already translated. */
  benefit: ReactNode;
  /** The Plus page tab this feature lives on. */
  tab?: PlusFeatureTab;
  className?: string;
}

/**
 * Tells the operator about one Levix Plus feature where it belongs. The server
 * decides access (usePlusStatus); the row never unlocks anything by itself.
 * It renders nothing when Plus is not offered on this platform.
 */
export function PlusFeatureRow({ title, benefit, tab, className }: PlusFeatureRowProps) {
  const { t } = useI18n();
  const { status, available } = usePlusStatus();
  const titleId = useId();
  const reasonId = useId();
  const access = accessFromStatus(status, available);

  if (access === "unavailable") return null;

  return (
    <Card
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}
      data-plus-access={access}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <PlusBadge crown>{t("plusTitle")}</PlusBadge>
          {access === "locked" && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted">
              <Lock aria-hidden size={13} />
              {t("plusRowLocked")}
            </span>
          )}
        </div>
        <p id={titleId} className="text-sm font-bold text-text-main">
          {title}
        </p>
        <p className="text-xs text-muted">
          {access === "unknown" ? t("plusRowChecking") : benefit}
        </p>
      </div>
      {access === "active" && (
        <LinkButton
          href={plusHash(tab)}
          size="sm"
          className="self-start sm:self-center"
          aria-describedby={titleId}
        >
          {t("plusRowOpen")}
        </LinkButton>
      )}
      {access === "locked" && (
        <LinkButton
          href={plusHash()}
          size="sm"
          className="self-start sm:self-center"
          aria-describedby={titleId}
        >
          {t("plusRowLearnMore")}
        </LinkButton>
      )}
      {access === "unknown" && (
        <>
          <Button
            size="sm"
            className="self-start sm:self-center"
            disabled
            aria-describedby={reasonId}
            title={t("plusRowCheckingReason")}
          >
            {t("plusRowOpen")}
          </Button>
          <span id={reasonId} className="sr-only">
            {t("plusRowCheckingReason")}
          </span>
        </>
      )}
    </Card>
  );
}
