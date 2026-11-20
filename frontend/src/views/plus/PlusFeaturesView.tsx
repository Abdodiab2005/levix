// file: frontend/src/views/plus/PlusFeaturesView.tsx
import { Bot, EyeOff, MessageSquareHeart, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Callout, Tabs } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { type PlusFeatureTab, plusHash, plusTabFromHash } from "../../utils/plusAccess";
import { AutoReplyTab } from "./AutoReplyTab";
import { MessagesTab } from "./MessagesTab";
import { PresetsTab } from "./PresetsTab";
import { readPlusStatus } from "./plusApi";
import { VisibilityTab } from "./VisibilityTab";

/**
 * Proves the extension is still active before showing anything. Local state
 * never decides it: a 409 from any ext route re-reads /plus/status.
 */
export function PlusFeaturesView() {
  const { t } = useI18n();
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
  const [inactive, setInactive] = useState(false);

  const handleInactive = useCallback(() => {
    void (async () => {
      try {
        const status = await readPlusStatus();
        if (status.extension.state !== "active") setInactive(true);
      } catch {
        setInactive(true);
      }
    })();
  }, []);

  if (inactive)
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
