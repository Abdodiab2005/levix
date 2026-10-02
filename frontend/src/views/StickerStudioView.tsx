import { AlertTriangle, Sticker as StickerIcon } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { Capabilities, Sticker } from "../types";
import { cn } from "../utils/cn";
import { canPickHostSource } from "../utils/hostBridge";
import { explainError, stickerErrorMessage } from "../utils/stickerErrors";
import { CreateView } from "./stickers/CreateView";
import {
  bindHandoffNotice,
  type CreateSeed,
  claimCreateSeed,
  clearCreateSeed,
} from "./stickers/hostHandoff";
import { LibraryView } from "./stickers/LibraryView";
import { PacksView } from "./stickers/PacksView";

type TabId = "library" | "packs" | "favorites" | "create" | "recent";
const VALID_TABS: TabId[] = ["library", "packs", "favorites", "create", "recent"];

function parseTab(): TabId {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("stickers/")) {
    const sub = hash.slice("stickers/".length) as TabId;
    if (VALID_TABS.includes(sub)) return sub;
  }
  return "library";
}

interface StickerStudioViewProps {
  isConnected: boolean;
}

export const StickerStudioView: React.FC<StickerStudioViewProps> = ({ isConnected }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabId>(parseTab);
  const [createMounted, setCreateMounted] = useState(activeTab === "create");
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [capsTick, setCapsTick] = useState(0);
  const [incoming, setIncoming] = useState<CreateSeed | null>(null);
  const [revision, setRevision] = useState(0);

  const loadCaps = useCallback(() => {
    let live = true;
    setCapsError(null);
    api
      .getStickerCapabilities()
      .then((caps) => {
        if (live) setCapabilities(caps);
      })
      .catch((err) => {
        if (live) setCapsError(explainError(t, err));
      });
    return () => {
      live = false;
    };
  }, [t]);

  useEffect(() => {
    if (capsTick < 0) return;
    return loadCaps();
  }, [loadCaps, capsTick]);

  const changeTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    if (tab === "create") setCreateMounted(true);
    const next = `stickers/${tab}`;
    if (window.location.hash.replace(/^#/, "") !== next) window.location.hash = next;
  }, []);

  useEffect(() => {
    const onHash = () => setActiveTab(parseTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (activeTab === "create") setCreateMounted(true);
  }, [activeTab]);

  useEffect(() => {
    bindHandoffNotice((event) => {
      if (event.type === "saved") {
        toast(
          event.created ? t("stickerCreated") : t("alreadyInLibrary"),
          event.created ? "success" : "info",
        );
        if (event.qualityReduced) toast(t("qualityReduced"), "info");
        setRevision((value) => value + 1);
        return;
      }
      toast(stickerErrorMessage(t, event.code), "error");
    });
    return () => bindHandoffNotice(null);
  }, [t, toast]);

  useEffect(() => {
    const apply = () => {
      const seed = claimCreateSeed();
      if (!seed) return;
      setIncoming(seed);
      setCreateMounted(true);
      setActiveTab("create");
      if (!window.location.hash.startsWith("#stickers/create")) {
        window.location.hash = "stickers/create";
      }
    };
    apply();
    const onVisible = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const consumeIncoming = useCallback(() => {
    clearCreateSeed();
    setIncoming(null);
  }, []);

  const openInCreate = useCallback(
    async (sticker: Sticker) => {
      try {
        const response = await fetch(sticker.url, { credentials: "same-origin" });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        const trimmed = sticker.name.trim();
        const fileName = !trimmed
          ? "sticker.webp"
          : trimmed.toLowerCase().endsWith(".webp")
            ? trimmed
            : `${trimmed}.webp`;
        setIncoming({
          blob,
          name: fileName,
          source: "PANEL_UPLOAD",
          ...(canPickHostSource() ? { existingId: sticker.id } : {}),
        });
        changeTab("create");
      } catch (err) {
        toast(explainError(t, err), "error");
      }
    },
    [changeTab, t, toast],
  );

  const encoderMissing = capabilities !== null && !capabilities.webp;
  const tabs: { id: TabId; label: string }[] = [
    { id: "library", label: t("library") },
    { id: "packs", label: t("packs") },
    { id: "favorites", label: t("favorites") },
    { id: "create", label: t("create") },
    { id: "recent", label: t("recent") },
  ];

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-2xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
          <StickerIcon size={24} />
        </div>
        <div>
          <h2 className="text-lg md:text-xl font-bold text-text-main">{t("stickers")}</h2>
          <p className="text-xs md:text-sm text-muted mt-0.5">{t("stickersDesc")}</p>
        </div>
      </div>

      {encoderMissing && (
        <div className="rounded-2xl border border-warn/30 bg-warn/10 p-4 flex items-center gap-3">
          <AlertTriangle size={20} className="text-warn shrink-0" />
          <span className="text-sm text-warn font-medium">{t("stickerErr_ENCODER_MISSING")}</span>
        </div>
      )}

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="flex items-center gap-2 min-w-max">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => changeTab(tab.id)}
              className={cn(
                "px-4 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap min-h-10",
                activeTab === tab.id
                  ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
                  : "text-muted hover:bg-panel-hover hover:text-text-main",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "library" && (
        <LibraryView
          preset="all"
          isConnected={isConnected}
          gifEnabled={capabilities?.gif === true}
          refreshKey={revision}
          onOpenInCreate={(sticker) => void openInCreate(sticker)}
        />
      )}
      {activeTab === "favorites" && (
        <LibraryView
          preset="favorites"
          isConnected={isConnected}
          gifEnabled={capabilities?.gif === true}
          refreshKey={revision}
          onOpenInCreate={(sticker) => void openInCreate(sticker)}
        />
      )}
      {activeTab === "recent" && (
        <LibraryView
          preset="recent"
          isConnected={isConnected}
          gifEnabled={capabilities?.gif === true}
          refreshKey={revision}
          onOpenInCreate={(sticker) => void openInCreate(sticker)}
        />
      )}
      {activeTab === "packs" && (
        <PacksView
          isConnected={isConnected}
          gifEnabled={capabilities?.gif === true}
          onOpenInCreate={(sticker) => void openInCreate(sticker)}
        />
      )}
      {createMounted && (
        <div className={activeTab === "create" ? "" : "hidden"}>
          <CreateView
            capabilities={capabilities}
            capsError={capsError}
            onRetryCaps={() => setCapsTick((value) => value + 1)}
            incoming={incoming}
            onConsumedIncoming={consumeIncoming}
            isConnected={isConnected}
            onGoLibrary={() => changeTab("library")}
            onCreated={() => setRevision((value) => value + 1)}
          />
        </div>
      )}
    </div>
  );
};
