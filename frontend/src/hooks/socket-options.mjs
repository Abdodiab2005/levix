// The Android panel is a unix socket reached through WebView request interception.
// WebSockets cannot be intercepted, so tryAllTransports makes engine.io fall back
// to HTTP long-polling when the WebSocket fails to open. Desktop browsers still
// open the WebSocket first.
export function dashboardSocketOptions() {
  return {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    tryAllTransports: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  };
}
