// Dashboard API.
//
// Everything the dashboard can read or change goes through here. It is mounted
// behind the session check (see src/index.js), so every handler already knows
// it is talking to whoever holds the panel password — the operator.
//
// Two rules the handlers follow:
//   * error text stays in the log. The internal message names collections and
//     server paths, and this response is rendered in a browser.
//   * nothing here can change the bot's identity. What the UI renders comes
//     from src/config/brand.cjs; what the model is told comes from
//     src/config/ai-identity.cjs, which this file does not import and no route
//     below returns. Neither is an editable field anywhere in the panel.

import { Router } from "express";
import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";

import {
  countGroups,
  countWarnings,
  countTodos,
  countNotes,
  countDebts,
  getAllGroupSettings,
  getGroupSettings,
  saveGroupSettings,
  getAllNotesFlat,
  getAllWarnings,
  getAllTodos,
  getAllUsers,
  getRecentDebts,
  countSchedules,
  getSchedules,
} from "../utils/storage.esm.js";
import {
  getCommandCatalog,
  rebuildCommandIndex,
} from "../handlers/command.handler.js";
import { groupMetadataCache } from "../core/socket.js";
import { grantRole, revokeRole, listRoles } from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const settings = require("../config/settings.cjs");
const memory = require("../utils/memory.cjs");
const secrets = require("../config/secrets.cjs");
const { DATA_DIR } = require("../config/paths.cjs");
const {
  PERSONA_FILE,
  activeProviderKeySetting,
} = require("../services/aiAgent.cjs");
const { deleteScheduledJob, retryScheduledJob } = require("../../scheduler.cjs");
const { describeScheduledJob } = require("../utils/recurrence.cjs");

const router = Router();

// The backend's WhatsApp session manager (src/core/session.js). The routes ask
// it questions and give it orders; they never create or destroy a socket
// themselves, and nothing a browser does to its websocket reaches it.
let session = null;

export function setSession(manager) {
  session = manager;
}

/** The live socket, or null. Re-read every time — a reconnect replaces it. */
function currentSocket() {
  return session?.socket ?? null;
}

/** A safe snapshot even before the session manager has been handed over. */
function sessionState() {
  return (
    session?.getState() ?? {
      state: "idle",
      status: "Disconnected",
      connected: false,
      canStart: false,
      canStop: false,
      canUnlink: false,
      proxy: null,
      proxyChanged: false,
      terminal: false,
      hasQr: false,
      attempt: 0,
      maxAttempts: 0,
      nextRetryAt: null,
      reason: "no_session",
      detail: null,
      user: null,
      lastDisconnect: null,
      since: null,
    }
  );
}

// --- helpers --------------------------------------------------------------

function fail(res, error, label, status = 500) {
  logger.error({ err: error }, `[Dashboard API] ${label}`);
  res.status(status).json({ success: false, error: "Internal server error" });
}

/** A caller mistake (bad value, unknown command): safe to echo back. */
function badRequest(res, message) {
  res.status(400).json({ success: false, error: message });
}

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) =>
      fail(res, error, `${req.method} ${req.path} failed`)
    );
  };
}

// ===========================================================================
// Overview
// ===========================================================================

router.get("/stats", (req, res) => {
  try {
    const connection = sessionState();
    const sock = currentSocket();
    res.json({
      success: true,
      stats: {
        connection,
        totalGroups: countGroups(),
        totalWarnings: countWarnings(),
        totalTodos: countTodos(),
        totalNotes: countNotes(),
        totalDebts: countDebts(false),
        totalSettledDebts: countDebts(true),
        totalSchedules: countSchedules(),

        isConnected: connection.connected && !!sock?.user,
        botNumber: sock?.user?.id || null,
        botName: sock?.user?.name || null,

        prefix: runtimeConfig.getPrefix(),
        commandCount: getCommandCatalog().length,
        // The active provider's key — "AI key: Not set" must mean what the
        // bot will actually use, not whatever gemini_api_key happens to hold.
        aiConfigured: !!settings.get(activeProviderKeySetting()),

        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        dataDir: DATA_DIR,
        database: true,
      },
    });
  } catch (error) {
    fail(res, error, "Error fetching stats");
  }
});

router.get("/health", (req, res) => {
  const connection = sessionState();
  res.json({
    success: true,
    health: {
      // Levix is healthy whether or not WhatsApp is linked: the panel is the
      // only surface, and it answers long before a pairing exists.
      status: "healthy",
      database: true,
      bot: connection.connected ? "connected" : "disconnected",
      session: connection.state,
      uptime: process.uptime(),
      timestamp: Date.now(),
    },
  });
});

// ===========================================================================
// Commands — prefix, permissions, aliases, on/off
// ===========================================================================

router.get("/commands", (req, res) => {
  try {
    res.json({
      success: true,
      prefix: runtimeConfig.getPrefix(),
      levels: runtimeConfig.PERMISSION_LEVELS,
      commands: getCommandCatalog(),
    });
  } catch (error) {
    fail(res, error, "Error listing commands");
  }
});

router.patch("/commands/:name", (req, res) => {
  const catalog = getCommandCatalog();
  const command = catalog.find((entry) => entry.name === req.params.name);
  if (!command) return badRequest(res, "Unknown command");

  const { permission, aliases, enabled } = req.body || {};
  let indexNeedsRebuild = false;

  try {
    if (permission !== undefined) {
      // A command that calls groupParticipantsUpdate needs a real WhatsApp
      // admin whatever this table says, so offering to lower it would lie.
      if (command.permissionLocked) {
        return badRequest(
          res,
          "This command always requires a WhatsApp group admin, so its permission is fixed."
        );
      }
      runtimeConfig.setPermission(command.key, permission || null);
    }

    if (aliases !== undefined) {
      if (aliases !== null && !Array.isArray(aliases)) {
        return badRequest(res, "Aliases must be a list");
      }

      // An alias that already belongs to another command would silently lose
      // the race in the loader; reject it here where we can say why.
      if (Array.isArray(aliases)) {
        const taken = new Map();
        for (const entry of catalog) {
          if (entry.name === command.name) continue;
          taken.set(entry.name, entry.name);
          for (const alias of entry.aliases) taken.set(alias, entry.name);
        }
        for (const raw of aliases) {
          const alias = String(raw ?? "").trim().toLowerCase();
          if (taken.has(alias)) {
            return badRequest(
              res,
              `"${alias}" is already used by !${taken.get(alias)}`
            );
          }
        }
      }

      runtimeConfig.setAliases(command.name, aliases);
      indexNeedsRebuild = true;
    }

    if (enabled !== undefined) {
      runtimeConfig.setEnabled(command.name, !!enabled);
    }
  } catch (error) {
    return badRequest(res, error.message);
  }

  // Make the new triggers live now rather than after a restart.
  if (indexNeedsRebuild) rebuildCommandIndex();

  const updated = getCommandCatalog().find(
    (entry) => entry.name === command.name
  );
  res.json({ success: true, command: updated });
});

// ===========================================================================
// Settings — everything the operator can change while the bot runs
// ===========================================================================

router.get("/settings", (req, res) => {
  try {
    res.json({
      success: true,
      prefix: runtimeConfig.getPrefix(),
      settings: settings.describe(),
    });
  } catch (error) {
    fail(res, error, "Error reading settings");
  }
});

router.patch("/settings", (req, res) => {
  const { key, value } = req.body || {};
  if (typeof key !== "string" || !key) return badRequest(res, "key is required");

  try {
    if (key === "prefix") {
      const prefix = runtimeConfig.setPrefix(value);
      return res.json({ success: true, prefix });
    }

    settings.set(key, value);
    return res.json({
      success: true,
      // Never echo a value back: for a secret that would hand it to anyone who
      // gets a look at the page.
      settings: settings.describe(),
    });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

// ===========================================================================
// AI — the editable system prompt and the long-term memory files
// ===========================================================================

// The persona file is "note to the human" + `---` + the actual prompt. Only
// the prompt half is editable here; the note is preserved so the file keeps
// explaining itself to whoever opens it in an editor.
const PERSONA_SEPARATOR = "\n---\n";

function splitPersona(raw) {
  const index = raw.indexOf(PERSONA_SEPARATOR);
  if (index === -1) return { header: "", body: raw.trim() };
  return {
    header: raw.slice(0, index).trim(),
    body: raw.slice(index + PERSONA_SEPARATOR.length).trim(),
  };
}

router.get("/ai/persona", (req, res) => {
  try {
    const raw = fs.existsSync(PERSONA_FILE)
      ? fs.readFileSync(PERSONA_FILE, "utf8")
      : "";
    const { header, body } = splitPersona(raw);
    res.json({
      success: true,
      persona: { header, body, file: path.basename(PERSONA_FILE) },
    });
  } catch (error) {
    fail(res, error, "Error reading persona");
  }
});

router.put("/ai/persona", (req, res) => {
  const body = req.body?.body;
  if (typeof body !== "string") return badRequest(res, "body must be text");
  if (body.length > 20000) return badRequest(res, "Persona is too long (20k max)");

  try {
    const raw = fs.existsSync(PERSONA_FILE)
      ? fs.readFileSync(PERSONA_FILE, "utf8")
      : "";
    const { header } = splitPersona(raw);
    const next = `${header}\n${PERSONA_SEPARATOR}\n${body.trim()}\n`;
    fs.writeFileSync(PERSONA_FILE, next, "utf8");
    logger.info("[Dashboard] AI persona updated");
    res.json({ success: true, persona: { header, body: body.trim() } });
  } catch (error) {
    fail(res, error, "Error writing persona");
  }
});

// Memory files: `global`, or one chat. The scope is turned into a path by
// memory.cjs and then re-checked against the memory root, so a crafted scope
// can't walk out of it.
function memoryPathFor(scope) {
  const filePath =
    scope === "global"
      ? memory.GLOBAL_FILE
      : memory.memoryFilePath("chat", scope);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(memory.ROOT) + path.sep)) {
    throw new Error("Refusing to touch a file outside the memory folder");
  }
  return resolved;
}

router.get("/ai/memory", (req, res) => {
  try {
    const scopes = [];

    if (fs.existsSync(memory.GLOBAL_FILE)) {
      const stat = fs.statSync(memory.GLOBAL_FILE);
      scopes.push({
        scope: "global",
        label: "Global memory",
        entries: memory.listMemory({ scope: "global" }).length,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
      });
    }

    if (fs.existsSync(memory.CHATS_DIR)) {
      for (const file of fs.readdirSync(memory.CHATS_DIR)) {
        if (!file.endsWith(".md")) continue;
        const chatId = file.slice(0, -3);
        const stat = fs.statSync(path.join(memory.CHATS_DIR, file));
        scopes.push({
          scope: chatId,
          label: chatId,
          entries: memory.listMemory({ scope: "chat", chatId }).length,
          bytes: stat.size,
          updatedAt: stat.mtimeMs,
        });
      }
    }

    res.json({ success: true, scopes });
  } catch (error) {
    fail(res, error, "Error listing memory");
  }
});

router.get("/ai/memory/:scope", (req, res) => {
  try {
    const filePath = memoryPathFor(req.params.scope);
    const content = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : "";
    res.json({ success: true, scope: req.params.scope, content });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.put("/ai/memory/:scope", (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") return badRequest(res, "content must be text");
  if (content.length > 200000) return badRequest(res, "Memory file is too long");

  try {
    const filePath = memoryPathFor(req.params.scope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    logger.info(`[Dashboard] memory updated: ${req.params.scope}`);
    res.json({ success: true });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.delete("/ai/memory/:scope", (req, res) => {
  try {
    const filePath = memoryPathFor(req.params.scope);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    logger.info(`[Dashboard] memory deleted: ${req.params.scope}`);
    res.json({ success: true });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

// ===========================================================================
// Groups
// ===========================================================================

function groupView(groupId, stored) {
  const metadata = groupMetadataCache.get(groupId) || null;
  const config = stored || {};

  return {
    id: groupId,
    subject: metadata?.subject || null,
    participants: metadata?.participants?.length ?? null,
    antilink: {
      enabled: !!config.antilink?.enabled,
      mode: config.antilink?.mode || "ALL",
      allowed_domains: config.antilink?.allowed_domains || [],
    },
    antispam: {
      enabled: !!config.antispam?.enabled,
      time_window: config.antispam?.time_window ?? 10,
      message_count: config.antispam?.message_count ?? 5,
      action: config.antispam?.action || "WARN",
    },
    media_control: {
      enabled: !!config.media_control?.enabled,
      blocked_types: config.media_control?.blocked_types || [],
    },
    welcome_system: {
      enabled: !!config.welcome_system?.enabled,
      messages: config.welcome_system?.messages || [],
    },
    warn_system: {
      max_warnings: config.warn_system?.max_warnings ?? 3,
      action: config.warn_system?.action || "NONE",
    },
    join_requests: {
      auto_approve_enabled: !!config.join_requests?.auto_approve_enabled,
    },
    rules: config.rules || "",
    blacklist: config.blacklist || [],
  };
}

router.get("/groups", (req, res) => {
  try {
    const stored = new Map(
      getAllGroupSettings().map((row) => [row.group_id, row.settings || {}])
    );

    // Groups the bot is in but that have no settings row yet still belong in
    // the list — that's exactly where the operator goes to configure them.
    const ids = new Set(stored.keys());
    for (const jid of groupMetadataCache.keys()) ids.add(jid);

    const groups = [...ids]
      .map((id) => groupView(id, stored.get(id)))
      .sort((a, b) => (a.subject || a.id).localeCompare(b.subject || b.id));

    res.json({ success: true, groups });
  } catch (error) {
    fail(res, error, "Error fetching groups");
  }
});

const MEDIA_TYPES = ["image", "video", "sticker", "audio"];
const ANTILINK_MODES = ["ALL", "WHITELIST", "BLACKLIST"];

router.patch("/groups/:id", (req, res) => {
  const groupId = req.params.id;
  if (!groupId.endsWith("@g.us")) return badRequest(res, "Not a group id");

  const patch = req.body || {};
  const current = getGroupSettings(groupId) || {};

  try {
    if (patch.antilink) {
      const next = { ...(current.antilink || {}) };
      if (patch.antilink.enabled !== undefined) next.enabled = !!patch.antilink.enabled;
      if (patch.antilink.mode !== undefined) {
        const mode = String(patch.antilink.mode).toUpperCase();
        if (!ANTILINK_MODES.includes(mode)) throw new Error("Unknown antilink mode");
        next.mode = mode;
      }
      if (patch.antilink.allowed_domains !== undefined) {
        if (!Array.isArray(patch.antilink.allowed_domains)) {
          throw new Error("allowed_domains must be a list");
        }
        next.allowed_domains = patch.antilink.allowed_domains
          .map((domain) => String(domain).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 50);
      }
      next.mode = next.mode || "ALL";
      next.allowed_domains = next.allowed_domains || [];
      current.antilink = next;
    }

    if (patch.antispam) {
      const next = { ...(current.antispam || {}) };
      if (patch.antispam.enabled !== undefined) next.enabled = !!patch.antispam.enabled;
      if (patch.antispam.time_window !== undefined) {
        const seconds = Number(patch.antispam.time_window);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
          throw new Error("time_window must be between 1 and 600 seconds");
        }
        next.time_window = Math.trunc(seconds);
      }
      if (patch.antispam.message_count !== undefined) {
        const count = Number(patch.antispam.message_count);
        if (!Number.isFinite(count) || count < 2 || count > 100) {
          throw new Error("message_count must be between 2 and 100");
        }
        next.message_count = Math.trunc(count);
      }
      if (patch.antispam.action !== undefined) {
        const action = String(patch.antispam.action).toUpperCase();
        if (!["KICK", "WARN"].includes(action)) throw new Error("Unknown antispam action");
        next.action = action;
      }
      current.antispam = {
        enabled: !!next.enabled,
        time_window: next.time_window ?? 10,
        message_count: next.message_count ?? 5,
        action: next.action || "WARN",
      };
    }

    if (patch.media_control) {
      const next = { ...(current.media_control || {}) };
      if (patch.media_control.enabled !== undefined) {
        next.enabled = !!patch.media_control.enabled;
      }
      if (patch.media_control.blocked_types !== undefined) {
        if (!Array.isArray(patch.media_control.blocked_types)) {
          throw new Error("blocked_types must be a list");
        }
        const types = patch.media_control.blocked_types.map((type) =>
          String(type).toLowerCase()
        );
        for (const type of types) {
          if (!MEDIA_TYPES.includes(type)) throw new Error(`Unknown media type: ${type}`);
        }
        next.blocked_types = [...new Set(types)];
      }
      current.media_control = {
        enabled: !!next.enabled,
        blocked_types: next.blocked_types || [],
      };
    }

    if (patch.welcome_system) {
      const next = { ...(current.welcome_system || {}) };
      if (patch.welcome_system.enabled !== undefined) {
        next.enabled = !!patch.welcome_system.enabled;
      }
      if (patch.welcome_system.messages !== undefined) {
        if (!Array.isArray(patch.welcome_system.messages)) {
          throw new Error("messages must be a list");
        }
        next.messages = patch.welcome_system.messages
          .map((message) => String(message).slice(0, 2000))
          .filter(Boolean)
          .slice(0, 20);
      }
      current.welcome_system = {
        enabled: !!next.enabled,
        messages: next.messages || [],
      };
    }

    if (patch.warn_system) {
      const next = { ...(current.warn_system || {}) };
      if (patch.warn_system.max_warnings !== undefined) {
        const max = Number(patch.warn_system.max_warnings);
        if (!Number.isFinite(max) || max < 1 || max > 50) {
          throw new Error("max_warnings must be between 1 and 50");
        }
        next.max_warnings = Math.trunc(max);
      }
      if (patch.warn_system.action !== undefined) {
        const action = String(patch.warn_system.action).toUpperCase();
        if (!["KICK", "NONE"].includes(action)) throw new Error("Unknown warn action");
        next.action = action;
      }
      current.warn_system = {
        max_warnings: next.max_warnings ?? 3,
        action: next.action || "NONE",
      };
    }

    if (patch.join_requests) {
      current.join_requests = {
        auto_approve_enabled: !!patch.join_requests.auto_approve_enabled,
      };
    }

    if (patch.rules !== undefined) {
      current.rules = String(patch.rules).slice(0, 4000);
    }
  } catch (error) {
    return badRequest(res, error.message);
  }

  try {
    saveGroupSettings(groupId, current);
    logger.info(`[Dashboard] group settings updated: ${groupId}`);
    res.json({ success: true, group: groupView(groupId, current) });
  } catch (error) {
    fail(res, error, "Error saving group settings");
  }
});

// ===========================================================================
// Data tables
// ===========================================================================

router.get("/debts", (req, res) => {
  try {
    res.json({ success: true, debts: getRecentDebts(200) });
  } catch (error) {
    fail(res, error, "Error fetching debts");
  }
});

router.get("/notes", (req, res) => {
  try {
    res.json({ success: true, notes: getAllNotesFlat(300) });
  } catch (error) {
    fail(res, error, "Error fetching notes");
  }
});

router.get("/warnings", (req, res) => {
  try {
    const warnings = getAllWarnings().sort((a, b) =>
      a.group_id.localeCompare(b.group_id)
    );
    res.json({ success: true, warnings });
  } catch (error) {
    fail(res, error, "Error fetching warnings");
  }
});

router.get("/todos", (req, res) => {
  try {
    res.json({ success: true, todos: getAllTodos() });
  } catch (error) {
    fail(res, error, "Error fetching todos");
  }
});

router.get("/users", (req, res) => {
  try {
    const users = getAllUsers()
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 500);
    res.json({ success: true, users });
  } catch (error) {
    fail(res, error, "Error fetching users");
  }
});

// ===========================================================================
// Roles (bot owner / bot admin)
// ===========================================================================

router.get("/roles", (req, res) => {
  try {
    res.json({ success: true, roles: listRoles() });
  } catch (error) {
    fail(res, error, "Error listing roles");
  }
});

router.post("/roles", (req, res) => {
  const { target, role, action } = req.body || {};

  const phone = String(target ?? "").replace(/\D/g, "");
  if (!phone || phone.length < 8 || phone.length > 15) {
    return badRequest(res, "Enter a phone number in international format");
  }
  if (!["owner", "admin"].includes(role)) return badRequest(res, "Unknown role");
  if (!["grant", "revoke"].includes(action)) return badRequest(res, "Unknown action");

  try {
    const jid = `${phone}@s.whatsapp.net`;
    if (action === "grant") grantRole(jid, role);
    else revokeRole(jid, role);
    logger.info(`[Dashboard] ${action} ${role}: ${phone}`);
    res.json({ success: true, roles: listRoles() });
  } catch (error) {
    fail(res, error, "Error changing a role");
  }
});

// ===========================================================================
// Scheduled messages
// ===========================================================================

function scheduleView(job) {
  if (!job) return null;
  const timezone = settings.get("bot_timezone");
  return { ...job, when: describeScheduledJob(job, timezone) };
}

function scheduleViews() {
  return getSchedules().map(scheduleView);
}

router.get("/schedules", (req, res) => {
  try {
    res.json({
      success: true,
      timezone: settings.get("bot_timezone"),
      schedules: scheduleViews(),
    });
  } catch (error) {
    fail(res, error, "Error listing schedules");
  }
});

router.delete("/schedules/:id", (req, res) => {
  try {
    // Through the scheduler, not the store: the running timer/cron task has to
    // be stopped too, or a deleted job still fires until the next restart.
    deleteScheduledJob(req.params.id);
    res.json({ success: true, schedules: scheduleViews() });
  } catch (error) {
    fail(res, error, "Error deleting a schedule");
  }
});

router.post(
  "/schedules/:id/retry",
  asyncRoute(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id || id.length > 128) return badRequest(res, "Invalid schedule ID");

    const sock = currentSocket();
    if (!sessionState().connected || !sock) {
      return res.status(409).json({
        success: false,
        error: "Connect WhatsApp before retrying a schedule",
      });
    }

    const result = await retryScheduledJob(sock, id);
    if (result.reason === "not_found") {
      return res.status(404).json({ success: false, error: "Schedule not found" });
    }
    if (result.reason === "not_failed") {
      return res.status(409).json({
        success: false,
        error: "Only a failed delivery can be retried",
      });
    }
    if (result.reason === "in_flight") {
      return res.status(409).json({
        success: false,
        error: "This schedule is already being delivered",
      });
    }
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        error: "WhatsApp delivery failed; the schedule remains retryable",
        schedule: scheduleView(result.job),
      });
    }

    res.json({ success: true, schedule: scheduleView(result.job) });
  })
);

// ===========================================================================
// Security — the panel's own password
// ===========================================================================

router.post("/security/password", (req, res) => {
  const { current, next } = req.body || {};

  // Being signed in isn't enough: an unattended browser shouldn't be able to
  // lock the real operator out.
  if (!secrets.verifyDashboardPassword(current)) {
    return res.status(401).json({ success: false, error: "Current password is wrong" });
  }

  try {
    secrets.setDashboardPassword(next);
  } catch (error) {
    return badRequest(res, error.message);
  }

  res.json({ success: true });
});

// ===========================================================================
// Bot control
// ===========================================================================

// The WhatsApp session. These four routes are the only way a browser can
// influence it, and each is a request to the backend's state machine rather
// than an instruction to make or break a socket. Everything under
// /dashboard/api is already behind the panel session and the cross-origin
// check in app.cjs, so no new surface is exposed here.

// The whole Connection screen in one request, including the QR already on
// screen. Without the code here a dashboard opened (or reloaded) while a
// pairing was already waiting showed an empty frame until Baileys happened to
// issue the next one.
router.get("/bot/session", (req, res) => {
  res.json({ success: true, session: sessionState(), qr: session?.qr ?? null });
});

// Idempotent by construction: the manager returns the state it is already in
// when a socket exists or is being made, so a double-click, two operators and a
// retry firing at the same moment all end up with exactly one socket.
router.post(
  "/bot/session/start",
  asyncRoute(async (req, res) => {
    if (!session) {
      return res.status(503).json({ success: false, error: "Session manager is not ready" });
    }
    const state = await session.start({ reason: "dashboard" });
    logger.info(`[Dashboard] Start session requested — now ${state.state}`);
    res.json({ success: true, session: state });
  })
);

// Apply configuration that only a new socket can pick up — the proxy, today.
// It goes through the session's own stop()+start(), so this route creates
// nothing and the state machine stays the only thing that owns a socket.
router.post(
  "/bot/session/reconnect",
  asyncRoute(async (req, res) => {
    if (!session) {
      return res.status(503).json({ success: false, error: "Session manager is not ready" });
    }
    const state = await session.reconnect({ reason: "dashboard" });
    logger.info(`[Dashboard] Reconnect requested — now ${state.state}`);
    res.json({ success: true, session: state });
  })
);

// Stop talking to WhatsApp but keep the pairing. No retry follows a manual
// stop, and any pending one is cancelled.
router.post(
  "/bot/session/stop",
  asyncRoute(async (req, res) => {
    if (!session) {
      return res.status(503).json({ success: false, error: "Session manager is not ready" });
    }
    const state = await session.stop({ reason: "dashboard" });
    logger.warn("[Dashboard] WhatsApp session stopped from the dashboard");
    res.json({ success: true, session: state });
  })
);

// Unlink the WhatsApp account: WhatsApp drops the companion device and the
// stored credentials go with it. Levix stays up, and the operator can start a
// fresh pairing whenever they want one.
router.post(
  "/bot/logout",
  asyncRoute(async (req, res) => {
    if (!session) {
      return res.status(503).json({ success: false, error: "Session manager is not ready" });
    }
    // Deliberately NOT gated on a live socket. A pairing WhatsApp has refused
    // (403, 405) leaves dead credentials with no connection to unlink through,
    // and that is precisely when the operator needs this.
    if (!sessionState().canUnlink) {
      return res.status(409).json({ success: false, error: "There is nothing linked to unlink" });
    }

    const state = await session.logout();
    logger.warn("[Dashboard] WhatsApp account unlinked from the dashboard");
    res.json({ success: true, session: state });
  })
);

// Only useful under a supervisor (pm2 / systemd / docker restart:always) —
// this stops the process and something else has to bring it back.
//
// SIGTERM to ourselves rather than process.exit(): that is the path in
// src/index.js that cancels the reconnect timers, closes the WhatsApp socket,
// flushes the store and closes the database. Exiting straight from here skipped
// all four.
router.post("/bot/restart", (req, res) => {
  logger.warn("[Dashboard] restart requested");
  res.json({
    success: true,
    message: "Restarting. If the bot is not running under a supervisor, start it again yourself.",
  });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500).unref();
});

export default router;
