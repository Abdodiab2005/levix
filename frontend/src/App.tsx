// file: frontend/src/App.tsx
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { CrashBanner } from "./components/CrashBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GuidedTourProvider } from "./components/GuidedTour";
import { Header } from "./components/Header";
import { Sidebar, type ViewTab } from "./components/Sidebar";
import { ToastProvider, useToast } from "./components/Toasts";
import { I18nProvider, useI18n } from "./context/I18nContext";
import { useSocket } from "./hooks/useSocket";
import type { SessionState, SessionStatus } from "./types";
import { initWindowErrorHandlers } from "./utils/errorCapture";
import { AIAssistantView } from "./views/AIAssistantView";
import { AutoDeleteView } from "./views/autoDelete/AutoDeleteView";
import { CommandsView } from "./views/CommandsView";
import { ConnectionView } from "./views/ConnectionView";
import { GroupsView } from "./views/GroupsView";
import { LogsView } from "./views/LogsView";
import { TermsConsentDialog } from "./views/legal/TermsConsentDialog";
// Views
import { OverviewView } from "./views/OverviewView";
import { SchedulesView } from "./views/SchedulesView";
import { SettingsView } from "./views/SettingsView";
import { StickerStudioView } from "./views/StickerStudioView";

const VALID_VIEWS: ViewTab[] = [
  "overview",
  "connection",
  "commands",
  "ai",
  "groups",
  "autodelete",
  "schedules",
  "settings",
  "logs",
  "stickers",
];

function viewFromHash(): ViewTab {
  const head = window.location.hash.replace(/^#/, "").split("/")[0] as ViewTab;
  return VALID_VIEWS.includes(head) ? head : "overview";
}

const MainLayout: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();

  const [currentView, setCurrentView] = useState<ViewTab>(viewFromHash);

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
  const [acceptedStatus, setAcceptedStatus] = useState<SessionStatus | null>(null);
  const socketAtAccept = useRef<SessionStatus | null>(null);
  const statusRequestId = useRef(0);
  const wasConsentRequired = useRef(false);
  const [termsOpen, setTermsOpen] = useState(false);

  const refreshStatus = useCallback(async () => {
    const request = ++statusRequestId.current;
    try {
      const res = await api.getSession();
      if (request !== statusRequestId.current) return null;
      if (res?.session) {
        setInitialStatus({
          ...res.session,
          qr: res.qr ?? null,
          pairingCode: res.pairingCode ?? null,
        });
        return res.session as SessionStatus;
      } else if (res?.status) {
        setInitialStatus(res.status);
        return res.status as SessionStatus;
      }
    } catch {
      // ignore
    }
    return null;
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const activeStatus: SessionStatus | null =
    initialStatus || socketStatus || acceptedStatus
      ? {
          state: (socketStatus?.state || initialStatus?.state || "idle") as SessionState,
          ...(initialStatus || {}),
          ...(socketStatus || {}),
          // A queued consent snapshot can arrive after the acceptance response.
          ...(acceptedStatus && (!socketStatus || socketStatus.state === "consent_required")
            ? acceptedStatus
            : {}),
        }
      : null;

  useEffect(() => {
    if (
      acceptedStatus &&
      socketStatus &&
      socketStatus !== socketAtAccept.current &&
      socketStatus.state !== "consent_required"
    ) {
      setAcceptedStatus(null);
    }
  }, [acceptedStatus, socketStatus]);

  useEffect(() => {
    const required = activeStatus?.state === "consent_required";
    if (required && !wasConsentRequired.current) setTermsOpen(true);
    wasConsentRequired.current = required;
  }, [activeStatus?.state]);

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
      const head = window.location.hash.replace(/^#/, "").split("/")[0] as ViewTab;
      if (VALID_VIEWS.includes(head)) setCurrentView(head);
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
    autodelete: t("autoDelete"),
    schedules: t("schedules"),
    settings: t("settings"),
    logs: t("logs"),
    stickers: t("stickers"),
  };

  useEffect(() => {
    const unbind = initWindowErrorHandlers();
    return unbind;
  }, []);

  return (
    <div className="min-h-screen min-h-[100dvh] flex bg-bg text-text-main bg-ambient-glow overflow-x-clip relative">
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
          view={currentView}
          status={activeStatus}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
          <CrashBanner />
          <ErrorBoundary>
            {currentView === "overview" && (
              <OverviewView status={activeStatus} onNavigate={handleSelectView} />
            )}
            {currentView === "connection" && (
              <ConnectionView
                status={activeStatus}
                onRefresh={refreshStatus}
                onStatusUpdate={(s) => setInitialStatus((prev) => ({ ...(prev || {}), ...s }))}
                onReviewTerms={() => setTermsOpen(true)}
              />
            )}
            {currentView === "ai" && <AIAssistantView />}
            {currentView === "commands" && <CommandsView />}
            {currentView === "schedules" && (
              <SchedulesView isConnected={isConnected} onNavigate={handleSelectView} />
            )}
            {currentView === "groups" && <GroupsView />}
            {currentView === "autodelete" && <AutoDeleteView />}
            {currentView === "settings" && <SettingsView />}
            {currentView === "stickers" && <StickerStudioView isConnected={isConnected} />}
            {currentView === "logs" && <LogsView />}
          </ErrorBoundary>
        </main>
      </div>
      <TermsConsentDialog
        isOpen={termsOpen}
        onClose={() => setTermsOpen(false)}
        onAccepted={(next) => {
          socketAtAccept.current = socketStatus;
          statusRequestId.current++;
          setAcceptedStatus(next);
          setInitialStatus((prev) => ({ ...(prev || {}), ...next }));
          void refreshStatus().then((fresh) => {
            if (fresh) setAcceptedStatus(fresh.state === "consent_required" ? null : fresh);
          });
        }}
      />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <I18nProvider>
      <ToastProvider>
        <GuidedTourProvider>
          <MainLayout />
        </GuidedTourProvider>
      </ToastProvider>
    </I18nProvider>
  );
};

export default App;
