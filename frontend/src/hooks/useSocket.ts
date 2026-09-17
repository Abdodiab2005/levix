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

export function useSocket(onEvent?: (event: string, data: any) => void) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);

    const handleStatus = (status: SessionStatus) => {
      setSessionStatus(status);
      onEvent?.("status", status);
    };

    const handleQr = (qr: string) => {
      setSessionStatus((prev) => (prev ? { ...prev, qr } : { state: "waiting_for_qr", qr }));
      onEvent?.("qr", qr);
    };

    const handlePairingCode = (code: string) => {
      setSessionStatus((prev) =>
        prev ? { ...prev, pairingCode: code } : { state: "waiting_for_qr", pairingCode: code },
      );
      onEvent?.("pairing-code", code);
    };

    const handleAny = (event: string, ...args: any[]) => {
      onEvent?.(event, args[0]);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("status", handleStatus);
    socket.on("qr", handleQr);
    socket.on("pairing-code", handlePairingCode);
    socket.onAny(handleAny);

    setIsConnected(socket.connected);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("status", handleStatus);
      socket.off("qr", handleQr);
      socket.off("pairing-code", handlePairingCode);
      socket.offAny(handleAny);
    };
  }, [onEvent]);

  return { isConnected, sessionStatus, socket: getSocket() };
}
