// The operator's line to the developer.
//
// Google Play expects an app to offer a working way to reach its developer, and
// a self-hosted bot has nowhere local to put one: the panel runs on the phone
// that reports the problem. So the panel posts to /dashboard/api/feedback, and
// this file forwards it — from the server, not the browser — to
// POST /api/feedback on levix.leviro.net, which delivers it as a Telegram
// message to the developer (levix-ui: src/app/api/feedback/route.ts).
//
// Forwarding server-side is the point: the panel's page never talks to the
// website, so no cross-origin request is made from a browser holding a panel
// session, and the request carries the bot's own version and platform rather
// than whatever a page claims.
//
// Nothing is sent unless the operator presses Send, and nothing about WhatsApp
// — no message, chat, contact, credential or key — is ever attached. What goes
// out is exactly the four fields below plus the runtime facts in
// describeRuntime().

const fs = require("node:fs");
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");

const DEFAULT_ENDPOINT = "https://levix.leviro.net/api/feedback";

/** Matches the topics the website's own form offers. */
const TOPICS = Object.freeze(["bug", "idea", "question", "praise", "other"]);

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 2000;
const CONTACT_MAX = 200;

// One operator, pressing a button. This only exists so a stuck retry loop in a
// browser tab cannot turn into a flood the receiving end has to absorb.
const THROTTLE_MAX = 5;
const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
let attempts = [];

/** Seconds to wait, or 0 when a submission is allowed right now. */
function feedbackRetryAfter() {
  const now = Date.now();
  attempts = attempts.filter((at) => now - at < THROTTLE_WINDOW_MS);
  if (attempts.length < THROTTLE_MAX) return 0;
  return Math.max(1, Math.ceil((attempts[0] + THROTTLE_WINDOW_MS - now) / 1000));
}

function recordAttempt() {
  attempts.push(Date.now());
}

/**
 * Control characters would mangle the message on the way out; tabs and line
 * breaks are the exception, because a paragraph the operator typed is content.
 * Written as a scan rather than a regex — a control character inside a
 * character class is exactly what the linter rejects, with good reason.
 */
function stripControl(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    const control = code < 0x20 || code === 0x7f;
    if (!control || char === "\n" || char === "\r" || char === "\t") out += char;
  }
  return out;
}

function clean(value, max) {
  return stripControl(String(value ?? ""))
    .trim()
    .slice(0, max);
}

/**
 * Check what the panel sent.
 *
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateFeedback(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Expected a feedback object" };
  }

  const message = clean(body.message, MESSAGE_MAX);
  if (message.length < MESSAGE_MIN) {
    return { ok: false, error: `Write at least ${MESSAGE_MIN} characters` };
  }

  const topicRaw = clean(body.topic, 20);
  const topic = TOPICS.includes(topicRaw) ? topicRaw : "other";

  let rating = null;
  if (body.rating !== undefined && body.rating !== null && body.rating !== "") {
    const value = Number(body.rating);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return { ok: false, error: "Rating must be a whole number from 1 to 5" };
    }
    rating = value;
  }

  const contact = clean(body.contact, CONTACT_MAX) || null;

  return { ok: true, value: { message, topic, rating, contact } };
}

/** Where this copy of Levix is running — the part a bug report cannot do without. */
function describeRuntime() {
  let platform = `node-${process.platform}`;
  if (process.env.LEVIX_ANDROID === "1") platform = "android";
  else if (isDocker()) platform = "docker";
  else if (isPackaged()) platform = `sea-${process.platform}`;

  let version = "unknown";
  try {
    version = require("../../package.json").version || "unknown";
  } catch {
    // A packaged build without a readable manifest still sends the rest.
  }

  let locale = null;
  try {
    locale = settings.get("bot_language") || null;
  } catch {
    // The database may not be open yet; the field is optional.
  }

  return { version, platform, locale };
}

function isDocker() {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

function isPackaged() {
  try {
    return require("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

/** The receiving end's own wording is fine to show; its length is not. */
function safeRemoteError(value) {
  const text = clean(value, 200);
  return text || null;
}

/**
 * Forward one validated submission.
 *
 * @param {{ message: string, topic: string, rating: number|null, contact: string|null }} feedback
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function submitFeedback(feedback) {
  const endpoint = process.env.LEVIX_FEEDBACK_URL || DEFAULT_ENDPOINT;
  const runtime = describeRuntime();

  recordAttempt();

  let response;
  let data = null;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `Levix/${runtime.version} (${runtime.platform})`,
      },
      body: JSON.stringify({
        ...feedback,
        source: "panel",
        app: { version: runtime.version, platform: runtime.platform, locale: runtime.locale },
      }),
      signal: AbortSignal.timeout(15000),
    });
    data = await response.json().catch(() => null);
  } catch (error) {
    logger.warn({ err: error }, "[feedback] Could not reach the feedback endpoint");
    return {
      ok: false,
      status: 502,
      error: "Could not reach the Levix server. Check the bot's internet connection and try again.",
    };
  }

  if (response.ok && data?.ok) {
    logger.info(`[feedback] Sent (${feedback.topic}) from ${runtime.platform}`);
    return { ok: true };
  }

  const remote = safeRemoteError(data?.error);
  logger.warn(
    `[feedback] The endpoint refused the submission (HTTP ${response.status})${remote ? `: ${remote}` : ""}`,
  );

  if (response.status === 429) {
    return {
      ok: false,
      status: 429,
      error: remote || "Too many submissions for now. Try again in a little while.",
    };
  }
  if (response.status === 503) {
    return {
      ok: false,
      status: 503,
      error: "Feedback delivery is not switched on yet. Please use GitHub issues for now.",
    };
  }
  return {
    ok: false,
    status: 502,
    error: remote || "The feedback service refused the message. Please try again later.",
  };
}

module.exports = {
  TOPICS,
  MESSAGE_MIN,
  MESSAGE_MAX,
  CONTACT_MAX,
  validateFeedback,
  describeRuntime,
  feedbackRetryAfter,
  submitFeedback,
};
