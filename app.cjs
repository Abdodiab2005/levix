// file: app.cjs
//
// The control panel's HTTP surface. It is not optional: the panel is the only
// place the bot is configured, so there is always a server and always a login.
//
// Nothing here reads a configuration file or an environment variable. The
// session key is generated on first start (src/config/secrets.cjs), the
// password is chosen once from the browser, and the handful of HTTP knobs
// (port, proxy hops, extra origin) are settings in the database that the panel
// itself can change.

const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const session = require("express-session");

const logger = require("./src/utils/logger.cjs");
const { assetPath } = require("./src/config/paths.cjs");
const brand = require("./src/config/brand.cjs");
const settings = require("./src/config/settings.cjs");
const secrets = require("./src/config/secrets.cjs");
const { PanelSessionStore } = require("./src/panel/session-store.cjs");
const { getQrCode } = require("./src/utils/storage.cjs");
const {
  clientAddress,
  isDirectLocalRequest,
} = require("./src/utils/requestOrigin.cjs");

const SESSION_COOKIE_NAME = "wa.sid";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);

// Origin check for the socket: socket.io's `cors` option only covers polling,
// and the browser doesn't apply CORS to a websocket at all.
function isAllowedOrigin(origin, host) {
  if (!origin) return true; // curl / a mobile app: no browser to protect
  const extra = settings.get("dashboard_origin");
  if (extra && origin === extra) return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}

// Browsers may legitimately serialize the Origin header as the literal string
// "null" for a same-origin navigation in an opaque-origin context. Prefer
// Fetch Metadata when the browser sends it. Some Chromium form navigations omit
// Sec-Fetch-Site entirely, so only the two credential-gated auth forms get a
// narrow fallback for Origin:null; every other mutation remains strict.
const OPAQUE_ORIGIN_AUTH_PATHS = new Set(["/setup", "/login"]);
function isAllowedMutationRequest(req) {
  const origin = req.get("origin");
  const host = req.get("host");

  // Preserve the explicit dashboard_origin escape hatch before consulting
  // fetch metadata: a deliberately separate dashboard can be cross-site.
  if (origin && origin !== "null" && isAllowedOrigin(origin, host)) return true;

  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite === "same-origin") return true;
  if (fetchSite === "cross-site") return false;

  // Real Chromium can submit a top-level auth form with Origin:null and no
  // Sec-Fetch-Site header. Setup is still protected by the one-time setup code
  // for remote clients; login by the password; both share TCP-peer throttling.
  // Do not generalize this exception to dashboard APIs or logout.
  if (origin === "null" && !fetchSite && OPAQUE_ORIGIN_AUTH_PATHS.has(req.path)) {
    return true;
  }

  return isAllowedOrigin(origin, host);
}

// serveClient reads the browser bundle out of node_modules on every request,
// which a packaged build has no way to do. We vendor it in public/ instead —
// same reason qrcode.min.js is there rather than on a CDN.
const io = new Server(server, {
  serveClient: false,
  maxHttpBufferSize: 1e6,
  allowRequest: (req, callback) => {
    callback(null, isAllowedOrigin(req.headers.origin, req.headers.host));
  },
});

app.disable("x-powered-by");

// Behind a proxy (nginx / Cloudflare) this has to match the real number of
// hops, or req.ip is the proxy's address — or worse, one the client forged.
// Default: off, which is right when the panel is exposed directly.
const trustProxy = settings.get("trust_proxy");
// Remembered rather than re-read: whether a proxy is in front decides whether
// the first-run page can ever skip the setup code, and that must not change
// under us mid-process. See src/utils/requestOrigin.cjs.
const PROXY_CONFIGURED = Boolean(trustProxy);
if (PROXY_CONFIGURED) {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

// 100 KB is plenty for the small dashboard mutations. The dashboard API is the
// exception: it carries whole Markdown files (the AI persona, a memory file),
// so src/index.js mounts `dashboardJson` in front of it and this parser skips
// those paths.
const jsonBody = express.json({ limit: "100kb" });
const dashboardJson = express.json({ limit: "2mb" });

app.use((req, res, next) => {
  if (req.path.startsWith("/dashboard/api/")) return next();
  return jsonBody(req, res, next);
});

// SameSite=lax closes the classic CSRF; this is a cheap check on top of it for
// anything that changes state.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (isAllowedMutationRequest(req)) return next();
  return res.status(403).json({ error: "Cross-origin request rejected" });
});

function requireLoginApi(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// The QR and the dashboard are sensitive: no-store so a proxy or the browser's
// back button can't hand a signed-in page to someone else.
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

function requireLoginPage(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.redirect("/");
}

// Bind the engine by value rather than letting express require("ejs") lazily
// by name: a packaged build has no module resolver to answer that call.
app.engine("ejs", require("ejs").__express);
app.set("view engine", "ejs");
app.set("views", assetPath("views"));
// Name, tagline and credit for every template. Frozen — see brand.cjs.
app.locals.brand = brand;
app.use(express.static(assetPath("public")));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Levix is intentionally one process and one operator, so a small expiring
// in-memory store is enough. Unlike express-session's development MemoryStore,
// it is explicitly bounded and prunes expired entries instead of growing for
// the lifetime of the process. Sessions still disappear on restart by design.
const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: secrets.getSessionSecret(),
  store: new PanelSessionStore({ ttlMs: SESSION_MAX_AGE_MS }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // "auto" = Secure only on an HTTPS request, so the same install works on
    // http://localhost and behind a TLS proxy without a setting to get wrong.
    secure: "auto",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  },
});

app.use(sessionMiddleware);

// Every socket receives the pairing QR, so it goes through the same session.
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (socket.request.session?.loggedIn) return next();
  next(new Error("unauthorized"));
});

// --- Attempt throttling ---------------------------------------------------
// Shared by /login and /setup: both are a guess at a secret.
//
// Keyed on the TCP peer, never on `req.ip`: with `trust proxy` set, a client
// picks its own `req.ip` by writing a header, so it could rotate the value and
// never hit the limit.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();

function blockedFor(ip) {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAt > ATTEMPT_WINDOW_MS) attempts.delete(key);
  }
  const entry = attempts.get(ip);
  if (!entry || entry.count < MAX_ATTEMPTS) return 0;
  const remaining = ATTEMPT_WINDOW_MS - (now - entry.firstAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

// --- First run ------------------------------------------------------------
//
// Until a password exists there is nothing to log into. The panel shows a
// "choose your password" page instead.
//
// From a direct loopback connection that is all it asks: whoever is sitting at
// the machine is the operator. Every other request — remote, proxied, or merely
// carrying a forwarding header — also needs the setup code printed on the
// server's console, so claiming the bot requires access to the machine rather
// than to the port. See src/utils/requestOrigin.cjs for why this can't be
// `req.ip`.

function isLocalRequest(req) {
  return isDirectLocalRequest(req, { proxyConfigured: PROXY_CONFIGURED });
}

function renderSetup(req, res, error, status = 200) {
  res.status(status).render("setup", {
    error,
    needsCode: !isLocalRequest(req),
    minLength: secrets.MIN_PASSWORD_LENGTH,
  });
}

app.get("/setup", noStore, (req, res) => {
  if (secrets.hasDashboardPassword()) return res.redirect("/");
  renderSetup(req, res, null);
});

app.post("/setup", (req, res, next) => {
  if (secrets.hasDashboardPassword()) return res.redirect("/");

  const peer = clientAddress(req);
  const retryAfter = blockedFor(peer);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return renderSetup(req, res, "Too many attempts. Try again later.", 429);
  }

  const { password, confirm, code } = req.body || {};

  if (!isLocalRequest(req) && !secrets.setupCodeMatches(code)) {
    recordFailure(peer);
    logger.warn({ ip: peer }, "[dashboard] Setup attempted with a wrong code");
    return renderSetup(req, res, "Wrong setup code.", 401);
  }

  if (password !== confirm) {
    return renderSetup(req, res, "The two passwords don't match.", 400);
  }

  try {
    secrets.setDashboardPassword(password);
  } catch (error) {
    return renderSetup(req, res, error.message, 400);
  }

  attempts.delete(peer);
  logger.info({ ip: peer }, "[dashboard] Password set — first run complete");

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.loggedIn = true;
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(303, "/");
    });
  });
});

// --- Routes ---------------------------------------------------------------

app.get("/", noStore, (req, res) => {
  if (!secrets.hasDashboardPassword()) return res.redirect("/setup");
  if (req.session.loggedIn) return res.render("dashboard");
  return res.render("login", { error: null });
});

app.post("/login", (req, res, next) => {
  if (!secrets.hasDashboardPassword()) return res.redirect("/setup");

  const peer = clientAddress(req);
  const retryAfter = blockedFor(peer);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return res.status(429).render("login", {
      error: "Too many attempts. Try again later.",
    });
  }

  if (!secrets.verifyDashboardPassword(req.body?.password)) {
    recordFailure(peer);
    logger.warn({ ip: peer }, "[dashboard] Failed login attempt");
    return res.status(401).render("login", { error: "Incorrect Password" });
  }

  attempts.delete(peer);

  // A fresh id after login, or the id an attacker planted beforehand still works.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.loggedIn = true;
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(303, "/");
    });
  });
});

// POST, not GET: a link that changes state gets fired by an <img> or by the
// browser's prefetch.
app.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.redirect(303, "/");
  });
});

app.get("/qr", requireLoginPage, noStore, (req, res) => {
  const qr = getQrCode();
  res.render("qr", { qr: qr || "" });
});

// Unlink / restart / everything else live on the dashboard API
// (/dashboard/api/*), registered in src/index.js once the socket exists.

// The 404 and the error handler have to be registered after every route — put
// them here and they would swallow the routes index.js adds later.
function installFinalHandlers() {
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err, method: req.method, path: req.path }, "[http] Unhandled error");
    if (res.headersSent) return;
    res.status(err.statusCode || 500).json({ error: "Internal server error" });
  });
}

module.exports = {
  app,
  server,
  io,
  dashboardJson,
  requireLoginApi,
  requireLoginPage,
  noStore,
  installFinalHandlers,
};
