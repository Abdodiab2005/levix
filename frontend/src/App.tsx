// file: frontend/src/App.tsx
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api/client";
import { Header } from "./components/Header";
import { Sidebar, type ViewTab } from "./components/Sidebar";
import { ToastProvider, useToast } from "./components/Toasts";
import { I18nProvider, useI18n } from "./context/I18nContext";
import { useSocket } from "./hooks/useSocket";
import type { SessionState, SessionStatus } from "./types";
import { AIAssistantView } from "./views/AIAssistantView";
import { CommandsView } from "./views/CommandsView";
import { ConnectionView } from "./views/ConnectionView";
import { GroupsView } from "./views/GroupsView";
import { LogsView } from "./views/LogsView";
// Views
import { OverviewView } from "./views/OverviewView";
import { SchedulesView } from "./views/SchedulesView";
import { SettingsView } from "./views/SettingsView";

const MainLayout: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();

  const [currentView, setCurrentView] = useState<ViewTab>(() => {
    const hash = window.location.hash.replace(/^#/, "") as ViewTab;
    const validViews: ViewTab[] = [
      "overview",
      "connection",
      "commands",
      "ai",
      "groups",
      "schedules",
      "settings",
      "logs",
    ];
    return validViews.includes(hash) ? hash : "overview";
  });

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Realtime Socket listener
  const {
    isConnected: _socketConnected,
    sessionStatus: socketStatus,
    socket,
  } = useSocket((event, data) => {
    if (event === "status") {
      const state = (data as { state?: string })?.state;
      toast(`Connection state: ${state}`, "info");
    }
  });

  const [initialStatus, setInitialStatus] = useState<Partial<SessionStatus> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await api.getSession();
      if (res?.session) {
        setInitialStatus({
          ...res.session,
          qr: res.qr ?? null,
          pairingCode: res.pairingCode ?? null,
        });
      } else if (res?.status) {
        setInitialStatus(res.status);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const activeStatus: SessionStatus | null =
    initialStatus || socketStatus
      ? {
          state: ((socketStatus?.state || initialStatus?.state || "idle") as SessionState),
          ...(initialStatus || {}),
          ...(socketStatus || {}),
        }
      : null;

  const isConnected = activeStatus?.connected === true || activeStatus?.state === "connected";

  // Auto-poll in transitional states (starting, linking, waiting_for_qr without QR, reconnecting)
  useEffect(() => {
    const state = activeStatus?.state;
    const isTransitional =
      state === "starting" ||
      state === "linking" ||
      state === "reconnecting" ||
      (state === "waiting_for_qr" && !activeStatus?.qr && !activeStatus?.pairingCode);

    const intervalMs = isTransitional ? 2000 : 15000;
    const timer = setInterval(() => {
      refreshStatus();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [activeStatus?.state, activeStatus?.qr, activeStatus?.pairingCode, refreshStatus]);

  // Sync hash with view
  const handleSelectView = (view: ViewTab) => {
    setCurrentView(view);
    window.location.hash = view;
  };

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "") as ViewTab;
      if (hash) setCurrentView(hash);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const viewTitles: Record<ViewTab, string> = {
    overview: t("overview"),
    connection: t("connection"),
    commands: t("commands"),
    ai: t("ai"),
    groups: t("groups"),
    schedules: t("schedules"),
    settings: t("settings"),
    logs: t("logs"),
  };

  return (
    <div className="min-h-screen min-h-[100dvh] flex bg-bg text-text-main bg-ambient-glow overflow-x-hidden relative">
      <Sidebar
        currentView={currentView}
        onSelectView={handleSelectView}
        isOpenMobile={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onToggleMobileMenu={() => setMobileMenuOpen((prev) => !prev)}
          title={viewTitles[currentView] || "Dashboard"}
          status={activeStatus}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
          {currentView === "overview" && (
            <OverviewView status={activeStatus} onNavigate={handleSelectView} />
          )}
          {currentView === "connection" && (
            <ConnectionView
              status={activeStatus}
              onRefresh={refreshStatus}
              onStatusUpdate={(s) => setInitialStatus((prev) => ({ ...(prev || {}), ...s }))}
            />
          )}
          {currentView === "ai" && <AIAssistantView />}
          {currentView === "commands" && <CommandsView />}
          {currentView === "schedules" && (
            <SchedulesView isConnected={isConnected} onNavigate={handleSelectView} />
          )}
          {currentView === "groups" && <GroupsView />}
          {currentView === "settings" && <SettingsView />}
          {currentView === "logs" && <LogsView socket={socket} />}
        </main>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <I18nProvider>
      <ToastProvider>
        <MainLayout />
      </ToastProvider>
    </I18nProvider>
  );
};

export default App;
