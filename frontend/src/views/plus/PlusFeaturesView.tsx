// file: frontend/src/views/plus/PlusFeaturesView.tsx
import { Bot, EyeOff, MessageSquareHeart, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Callout, Tabs } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { usePlusStatus } from "../../hooks/usePlusStatus";
import {
  type PlusFeatureTab,
  accessFromStatus,
  plusHash,
  plusTabFromHash,
} from "../../utils/plusAccess";
import { AutoReplyTab } from "./AutoReplyTab";
import { MessagesTab } from "./MessagesTab";
import { PresetsTab } from "./PresetsTab";
import { VisibilityTab } from "./VisibilityTab";

/**
 * Proves Plus access is active through the shared server status store before
 * showing any feature tab. Local state never decides it: a 409 denial from any
 * ext route refreshes `usePlusStatus`.
 */
export function PlusFeaturesView() {
  const { t } = useI18n();
  const { status, available, refresh } = usePlusStatus();
  // #plus/<tab> (from an in-context Plus row) picks the starting tab.
  const [tab, setTab] = useState<PlusFeatureTab>(
    () => plusTabFromHash(window.location.hash) ?? "messages",
  );

  useEffect(() => {
    const onHash = () => {
      const next = plusTabFromHash(window.location.hash);
      if (next) setTab(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const handleInactive = useCallback(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  if (accessFromStatus(status, available) !== "active")
    return (
      <Callout tone="warn" title={t("plusTitle")}>
        {t("plusExtErrorInactive")}
      </Callout>
    );

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={tab}
        onChange={(next) => {
          setTab(next);
          // Keep #plus/<tab> in step so a reload or a later hashchange agrees.
          if (window.location.hash !== plusHash(next)) {
            window.history.replaceState(null, "", plusHash(next));
          }
        }}
        aria-label={t("plusTitle")}
        className="overflow-x-auto no-scrollbar"
        options={[
          {
            value: "messages",
            label: t("plusTabMessages"),
            icon: <MessageSquareHeart size={17} />,
          },
          { value: "presets", label: t("plusTabPresets"), icon: <Sparkles size={17} /> },
          { value: "visibility", label: t("plusTabVisibility"), icon: <EyeOff size={17} /> },
          { value: "autoReply", label: t("plusTabAutoReply"), icon: <Bot size={17} /> },
        ]}
      />
      {tab === "messages" && <MessagesTab onInactive={handleInactive} />}
      {tab === "presets" && <PresetsTab onInactive={handleInactive} />}
      {tab === "visibility" && <VisibilityTab onInactive={handleInactive} />}
      {tab === "autoReply" && <AutoReplyTab onInactive={handleInactive} />}
    </div>
  );
}
