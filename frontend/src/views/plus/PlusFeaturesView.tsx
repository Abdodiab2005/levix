// file: frontend/src/views/plus/PlusFeaturesView.tsx
import { Bot, EyeOff, MessageSquareHeart, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { Tabs } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { AutoReplyTab } from "./AutoReplyTab";
import { MessagesTab } from "./MessagesTab";
import { PresetsTab } from "./PresetsTab";
import { VisibilityTab } from "./VisibilityTab";
import { readPlusStatus } from "./plusApi";

type PlusFeatureTab = "messages" | "presets" | "visibility" | "autoReply";

/**
 * Proves the extension is still active before showing anything. Local state
 * never decides it: a 409 from any ext route re-reads /plus/status.
 */
export function PlusFeaturesView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<PlusFeatureTab>("messages");
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

  if (inactive) return <p className="text-sm text-muted">{t("plusExtErrorInactive")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={tab}
        onChange={setTab}
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
