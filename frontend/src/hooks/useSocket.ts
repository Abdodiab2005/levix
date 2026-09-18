// file: frontend/src/hooks/useSocket.ts
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { SessionStatus } from "../types";

let socketInstance: Socket | null = null;

function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(window.location.origin, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });
  }
  return socketInstance;
}

export function useSocket(onEvent?: (event: string, data: unknown) => void) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);

    // Full snapshot event emitted on every transition by WhatsAppSession
    const handleSession = (snapshot: Partial<SessionStatus>) => {
      setSessionStatus((prev) => ({
        ...prev,
        ...snapshot,
        state: snapshot?.state || prev?.state || "idle",
      }));
      onEvent?.("session", snapshot);
    };

    // Legacy status update
    const handleStatusUpdate = (data: { state?: SessionStatus["state"]; status?: string }) => {
      setSessionStatus((prev) => ({
        ...prev,
        state: data?.state || prev?.state || "idle",
        status: data?.status || prev?.status,
      }));
      onEvent?.("status_update", data);
    };

    const handleStatus = (status: SessionStatus) => {
      setSessionStatus((prev) => ({
        ...prev,
        ...status,
      }));
      onEvent?.("status", status);
    };

    const handleQr = (qr: string) => {
      setSessionStatus((prev) => ({
        ...prev,
        state: "waiting_for_qr",
        qr,
      }));
      onEvent?.("qr", qr);
    };

    const handlePairingCode = (data: unknown) => {
      const code =
        typeof data === "object" && data && "code" in data
          ? String((data as { code: unknown }).code)
          : String(data || "");
      setSessionStatus((prev) => ({
        ...prev,
        state: "waiting_for_qr",
        pairingCode: code,
      }));
      onEvent?.("pairing_code", code);
    };

    const handleQrCleared = () => {
      setSessionStatus((prev) => (prev ? { ...prev, qr: null } : null));
      onEvent?.("qr_cleared", {});
    };

    const handlePairingCodeCleared = () => {
      setSessionStatus((prev) => (prev ? { ...prev, pairingCode: null } : null));
      onEvent?.("pairing_code_cleared", {});
    };

    const handleAny = (event: string, ...args: unknown[]) => {
      onEvent?.(event, args[0]);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("session", handleSession);
    socket.on("status_update", handleStatusUpdate);
    socket.on("status", handleStatus);
    socket.on("qr", handleQr);
    socket.on("pairing_code", handlePairingCode);
    socket.on("pairing-code", handlePairingCode);
    socket.on("qr_cleared", handleQrCleared);
    socket.on("pairing_code_cleared", handlePairingCodeCleared);
    socket.onAny(handleAny);

    setIsConnected(socket.connected);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("session", handleSession);
      socket.off("status_update", handleStatusUpdate);
      socket.off("status", handleStatus);
      socket.off("qr", handleQr);
      socket.off("pairing_code", handlePairingCode);
      socket.off("pairing-code", handlePairingCode);
      socket.off("qr_cleared", handleQrCleared);
      socket.off("pairing_code_cleared", handlePairingCodeCleared);
      socket.offAny(handleAny);
    };
  }, [onEvent]);

  return { isConnected, sessionStatus, socket: getSocket() };
}
