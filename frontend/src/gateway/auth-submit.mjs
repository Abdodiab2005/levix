export async function submitGatewayForm(url, form, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "same-origin",
      body: new URLSearchParams(new FormData(form)),
      signal: controller.signal,
    });
    const result = await response.json();
    if (typeof result?.redirect === "string") return { redirect: result.redirect };
    if (typeof result?.error?.code === "string") {
      return {
        error: result.error,
        ...(result.retryAfter != null ? { retryAfter: result.retryAfter } : {}),
      };
    }
    throw new Error("Invalid gateway response");
  } catch {
    return { error: { code: "resetErrServer" } };
  } finally {
    clearTimeout(timeout);
  }
}

export function authDestination(currentHref, redirect, storedHash) {
  const current = new URL(currentHref);
  let destination;
  try {
    destination = new URL(redirect, current);
    if (destination.origin !== current.origin) destination = new URL("/", current);
  } catch {
    destination = new URL("/", current);
  }
  destination.hash = current.hash || storedHash || "";
  return {
    href: destination.href,
    reload: destination.pathname === current.pathname && destination.search === current.search,
  };
}

export function navigateAfterAuth(redirect, win = window) {
  let storedHash = "";
  try {
    storedHash = win.sessionStorage.getItem("__levixDeepLink") || "";
    win.sessionStorage.removeItem("__levixDeepLink");
  } catch {}
  const destination = authDestination(win.location.href, redirect, storedHash);
  if (destination.reload) {
    win.location.hash = new URL(destination.href).hash;
    win.location.reload();
  } else {
    win.location.replace(destination.href);
  }
}
