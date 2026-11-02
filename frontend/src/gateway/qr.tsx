import { useEffect, useRef, useState } from "react";
import { Button, LinkButton, StatusPill } from "../components/ui";
import type { GatewayKey, GatewayMarkup, GatewayText } from "./main";
import { loadScript } from "./script-loader.mjs";

type Socket = {
  on(event: "qr", callback: (value: string) => void): void;
  on(event: "qr_cleared", callback: () => void): void;
  on(event: "session", callback: (value: { state: string; canStart?: boolean }) => void): void;
  disconnect: () => void;
};
type QrConstructor = {
  new (element: HTMLElement, options: object): void;
  CorrectLevel: { H: number };
};
type QrWindow = Window & {
  io?: () => Socket;
  QRCode?: QrConstructor;
};

export function Qr({
  initial,
  t,
  markup,
}: {
  initial: string;
  t: GatewayText;
  markup: GatewayMarkup;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const qrValue = useRef(initial);
  const [status, setStatus] = useState<GatewayKey>(initial ? "qrScanMe" : "qrWaitingCode");
  const [linked, setLinked] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let socket: Socket | undefined;
    setLoadError(false);
    const paint = (qr: string) => {
      if (
        !active ||
        !frame.current ||
        !qr ||
        (qrValue.current === qr && frame.current.childNodes.length)
      )
        return;
      qrValue.current = qr;
      frame.current.replaceChildren();
      const ctor = (window as QrWindow).QRCode;
      if (ctor)
        new ctor(frame.current, {
          text: qr,
          width: 250,
          height: 250,
          correctLevel: ctor.CorrectLevel.H,
        });
      setLinked(false);
      setStatus("qrScanMe");
    };
    const clear = (key: GatewayKey) => {
      qrValue.current = "";
      frame.current?.replaceChildren();
      setLinked(false);
      setStatus(key);
    };
    void (async () => {
      await loadScript("/qrcode.min.js", () => typeof (window as QrWindow).QRCode === "function");
      if (!active) return;
      await loadScript("/socket.io.min.js", () => typeof (window as QrWindow).io === "function");
      if (!active) return;
      paint(initial);
      socket = (window as QrWindow).io?.();
      socket?.on("qr", paint);
      socket?.on("qr_cleared", () => clear("qrWaitingCode"));
      socket?.on("session", (session: { state: string; canStart?: boolean }) => {
        if (session.state === "connected") {
          qrValue.current = "";
          frame.current?.replaceChildren();
          setLinked(true);
          setStatus("qrConnected");
        } else if (session.state !== "waiting_for_qr")
          clear(session.canStart ? "qrNotStarted" : "qrConnecting");
      });
    })().catch(() => {
      if (active) setLoadError(true);
    });
    return () => {
      active = false;
      socket?.disconnect();
    };
  }, [initial, attempt]);
  return (
    <>
      <header>
        <p className="text-sm text-brand-cyan">{t("linkDevice")}</p>
        <h1 className="text-2xl font-bold">{t("qrScanTitle")}</h1>
        <StatusPill tone={status === "qrConnected" ? "ok" : "neutral"} dot>
          {t(status)}
        </StatusPill>
      </header>
      <div className="flex min-h-64 items-center justify-center rounded-xl border border-line bg-panel-raised p-3">
        {linked ? <strong>{t("qrLinked")}</strong> : <div ref={frame} />}
      </div>
      {loadError && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{t("qrLoadError")}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t("qrRetry")}</Button>
        </div>
      )}
      <ol className="list-decimal space-y-2 ps-5 text-sm text-muted">
        <li>{markup("qrStep1")}</li>
        <li>{markup("qrStep2")}</li>
        <li>{markup("qrStep3")}</li>
      </ol>
      <p className="text-sm text-muted">{markup("qrCallout")}</p>
      <LinkButton href="/" className="w-full">
        {t("backToDashboard")}
      </LinkButton>
    </>
  );
}
