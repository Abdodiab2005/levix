// file: frontend/src/App.tsx
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "./api/client";
import { Header } from "./components/Header";
import { Sidebar, type ViewTab } from "./components/Sidebar";
import { ToastProvider, useToast } from "./components/Toasts";
import { I18nProvider, useI18n } from "./context/I18nContext";
import { useSocket } from "./hooks/useSocket";
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
    isConnected: socketConnected,
    sessionStatus: socketStatus,
    socket,
  } = useSocket((event, data) => {
    if (event === "status") {
      toast(`Connection state: ${data?.state}`, "info");
    }
  });

  const [initialStatus, setInitialStatus] = useState<any>(null);

  useEffect(() => {
    api
      .getSession()
      .then((res) => {
        if (res?.status) setInitialStatus(res.status);
      })
      .catch(() => {});
  }, []);

  const activeStatus = socketStatus || initialStatus;

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
    <div className="app-shell">
      <Sidebar
        currentView={currentView}
        onSelectView={handleSelectView}
        isOpenMobile={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="main-content">
        <Header
          onToggleMobileMenu={() => setMobileMenuOpen((prev) => !prev)}
          title={viewTitles[currentView] || "Dashboard"}
          status={activeStatus}
        />

        <main className="view-container">
          {currentView === "overview" && (
            <OverviewView status={activeStatus} onNavigate={handleSelectView} />
          )}
          {currentView === "connection" && <ConnectionView status={activeStatus} />}
          {currentView === "ai" && <AIAssistantView />}
          {currentView === "commands" && <CommandsView />}
          {currentView === "schedules" && <SchedulesView />}
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
