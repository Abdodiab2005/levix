import type { ManagerOptions, SocketOptions } from "socket.io-client";

export function dashboardSocketOptions(): Partial<ManagerOptions & SocketOptions>;
