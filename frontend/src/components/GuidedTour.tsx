// file: frontend/src/components/GuidedTour.tsx

import {
  createContext,
  type FC,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../context/I18nContext";
import type { translations } from "../i18n/translations";
import { fill } from "../utils/fill";
import type { ViewTab } from "./Sidebar";
import { Tour, type TourStep } from "./ui";

type StepScreen = ViewTab | "sidebar";
type CopyKey = keyof (typeof translations)["en"];

interface GuidedStepDef {
  id: string;
  /** The `data-tour` attribute this step spotlights. */
  target: string;
  screen: StepScreen;
  /** Hash route to land on before this step's target is awaited. */
  hash?: string;
  /** Steps pointing into the desktop sidebar are skipped on small screens. */
  desktopOnly?: boolean;
  inMainTour?: boolean;
  titleKey: CopyKey;
  bodyKey: CopyKey;
}

const MAIN_ORDER: GuidedStepDef[] = [
  {
    id: "sidebar",
    target: "sidebar-nav",
    screen: "sidebar",
    desktopOnly: true,
    titleKey: "tourSidebarTitle",
    bodyKey: "tourSidebarBody",
  },
  {
    id: "connection-start",
    target: "connection-start",
    screen: "connection",
    hash: "connection",
    titleKey: "tourConnectionStartTitle",
    bodyKey: "tourConnectionStartBody",
  },
  {
    id: "connection-pairing",
    target: "connection-pairing",
    screen: "connection",
    hash: "connection",
    titleKey: "tourConnectionPairingTitle",
    bodyKey: "tourConnectionPairingBody",
  },
  {
    id: "overview-stats",
    target: "overview-stats",
    screen: "overview",
    hash: "overview",
    titleKey: "tourOverviewStatsTitle",
    bodyKey: "tourOverviewStatsBody",
  },
  {
    id: "commands-list",
    target: "commands-list",
    screen: "commands",
    hash: "commands",
    titleKey: "tourCommandsTitle",
    bodyKey: "tourCommandsBody",
  },
  {
    id: "ai-agent",
    target: "ai-agent",
    screen: "ai",
    hash: "ai",
    inMainTour: false,
    titleKey: "tourAiAgentTitle",
    bodyKey: "tourAiAgentBody",
  },
  {
    id: "ai-provider",
    target: "ai-provider",
    screen: "ai",
    hash: "ai",
    titleKey: "tourAiProviderTitle",
    bodyKey: "tourAiProviderBody",
  },
  {
    id: "ai-memory",
    target: "ai-memory",
    screen: "ai",
    hash: "ai",
    titleKey: "tourAiMemoryTitle",
    bodyKey: "tourAiMemoryBody",
  },
  {
    id: "groups-list",
    target: "groups-list",
    screen: "groups",
    hash: "groups",
    titleKey: "tourGroupsTitle",
    bodyKey: "tourGroupsBody",
  },
  {
    id: "stickers-tabs",
    target: "stickers-tabs",
    screen: "stickers",
    hash: "stickers",
    titleKey: "tourStickersTitle",
    bodyKey: "tourStickersBody",
  },
  {
    id: "schedules-list",
    target: "schedules-list",
    screen: "schedules",
    hash: "schedules",
    titleKey: "tourSchedulesTitle",
    bodyKey: "tourSchedulesBody",
  },
  {
    id: "logs-stream",
    target: "logs-stream",
    screen: "logs",
    hash: "logs",
    titleKey: "tourLogsTitle",
    bodyKey: "tourLogsBody",
  },
  {
    id: "settings-general",
    target: "settings-general",
    screen: "settings",
    hash: "settings",
    titleKey: "tourSettingsTitle",
    bodyKey: "tourSettingsBody",
  },
  {
    id: "settings-password",
    target: "settings-password",
    screen: "settings",
    hash: "settings/security",
    inMainTour: false,
    titleKey: "tourSettingsPasswordTitle",
    bodyKey: "tourSettingsPasswordBody",
  },
  {
    id: "settings-feedback",
    target: "settings-feedback",
    screen: "settings",
    hash: "settings/feedback",
    inMainTour: false,
    titleKey: "tourSettingsFeedbackTitle",
    bodyKey: "tourSettingsFeedbackBody",
  },
  {
    id: "settings-diagnostics",
    target: "settings-diagnostics",
    screen: "settings",
    hash: "settings/diagnostics",
    inMainTour: false,
    titleKey: "tourSettingsDiagnosticsTitle",
    bodyKey: "tourSettingsDiagnosticsBody",
  },
];

const TOUR_DONE_KEY = "levix_tour_v1_done";
const SIDEBAR_BREAKPOINT = 768; // md — the sidebar is static from here up

/** localStorage is blocked in some WebView modes; the tour must survive that. */
const readTourDone = () => {
  try {
    return window.localStorage.getItem(TOUR_DONE_KEY) === "1";
  } catch {
    return false;
  }
};
const markTourDone = () => {
  try {
    window.localStorage.setItem(TOUR_DONE_KEY, "1");
  } catch {
    // Storage blocked: the tour runs again next login instead of failing.
  }
};

interface GuidedTourApi {
  startMainTour: () => void;
  startScreenTour: (view: ViewTab) => void;
  hasScreenSteps: (view: ViewTab) => boolean;
}

const GuidedTourContext = createContext<GuidedTourApi | null>(null);

export const useGuidedTour = (): GuidedTourApi | null => useContext(GuidedTourContext);

const dialogOpen = () => Boolean(document.querySelector('[role="dialog"]'));

const sidebarVisible = () => window.innerWidth >= SIDEBAR_BREAKPOINT;

export const GuidedTourProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [session, setSession] = useState<GuidedStepDef[] | null>(null);
  const [index, setIndex] = useState(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const indexRef = useRef(index);
  indexRef.current = index;

  const start = useCallback((defs: GuidedStepDef[]) => {
    setSession(defs);
    setIndex(0);
  }, []);

  const startMainTour = useCallback(() => {
    if (dialogOpen() || sessionRef.current) return;
    start(
      MAIN_ORDER.filter(
        (def) => def.inMainTour !== false && (!def.desktopOnly || sidebarVisible()),
      ),
    );
  }, [start]);

  const startScreenTour = useCallback(
    (view: ViewTab) => {
      if (dialogOpen() || sessionRef.current) return;
      const defs = MAIN_ORDER.filter(
        (def) => def.screen === view && (!def.desktopOnly || sidebarVisible()),
      );
      if (defs.length === 0) return;
      start(defs);
    },
    [start],
  );

  const hasScreenSteps = useCallback(
    (view: ViewTab) =>
      MAIN_ORDER.some((def) => def.screen === view && (!def.desktopOnly || sidebarVisible())),
    [],
  );

  const finish = useCallback(() => {
    markTourDone();
    setSession(null);
    setIndex(0);
  }, []);

  const advance = useCallback(() => {
    const defs = sessionRef.current;
    if (!defs) return;
    const next = indexRef.current + 1;
    if (next >= defs.length) finish();
    else setIndex(next);
  }, [finish]);

  const goBack = useCallback(() => {
    if (indexRef.current > 0) setIndex(indexRef.current - 1);
  }, []);

  // Land on the step's screen first; the Tour primitive then waits (≤1.5 s)
  // for the data-tour target to appear and skips the step if it never does.
  useEffect(() => {
    if (!session) return;
    const def = session[index];
    if (def?.hash && window.location.hash !== `#${def.hash}`) {
      window.location.hash = def.hash;
    }
  }, [session, index]);

  // Runs once per fresh login in this browser (no key in localStorage yet),
  // only when no dialog is on screen — retried briefly while one is.
  useEffect(() => {
    let attempts = 0;
    let timer: number;
    const tryStart = () => {
      attempts += 1;
      if (sessionRef.current) return;
      if (readTourDone()) return;
      if (dialogOpen()) {
        if (attempts < 5) timer = window.setTimeout(tryStart, 600);
        return;
      }
      startMainTour();
    };
    timer = window.setTimeout(tryStart, 1200);
    return () => window.clearTimeout(timer);
  }, [startMainTour]);

  const steps = useMemo<TourStep[]>(
    () =>
      (session ?? []).map((def) => ({
        target: def.target,
        title: t(def.titleKey),
        body: t(def.bodyKey),
      })),
    [session, t],
  );

  const labels = useMemo(
    () => ({
      back: t("tourBack"),
      next: t("tourNext"),
      done: t("tourDone"),
      skip: t("tourSkip"),
      stepOf: session ? fill(t("tourStepOf"), { n: index + 1, total: session.length }) : "",
    }),
    [t, session, index],
  );

  const api = useMemo<GuidedTourApi>(
    () => ({ startMainTour, startScreenTour, hasScreenSteps }),
    [startMainTour, startScreenTour, hasScreenSteps],
  );

  return (
    <GuidedTourContext.Provider value={api}>
      {children}
      <Tour
        open={Boolean(session)}
        steps={steps}
        index={index}
        onAdvance={advance}
        onBack={goBack}
        onClose={finish}
        labels={labels}
      />
    </GuidedTourContext.Provider>
  );
};
