/* Levix dashboard — plain browser JS, no framework, no build step.
 *
 * Everything it shows comes from /dashboard/api/*, which sits behind the same
 * session as this page. Every value rendered here started life as a WhatsApp
 * message (a note, a warning reason, a group subject), so it goes through
 * esc() before it touches innerHTML.
 */

(() => {
  "use strict";

  // --- tiny helpers -------------------------------------------------------

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);

  const shortJid = (jid) => String(jid ?? "").split("@")[0];

  function timeAgo(ms) {
    if (!ms) return "—";
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function humanUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function toast(message, kind = "") {
    const box = $("#toasts");
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    box.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  /**
   * Every call goes through here so an expired session sends the operator back
   * to the login page instead of leaving a dashboard that silently stops
   * updating.
   */
  async function api(path, options = {}) {
    const response = await fetch(`/dashboard/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 401) {
      window.location.assign("/");
      throw new Error("Session expired");
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  /** Wrap an action so a failure lands in a toast instead of the console. */
  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        toast(error.message, "error");
      }
    };
  }

  // --- theme --------------------------------------------------------------

  const THEME_KEY = "levix.theme";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const button = $("#theme-btn");
    button.setAttribute(
      "aria-label",
      theme === "light" ? "Switch to dark theme" : "Switch to light theme"
    );
    button.setAttribute(
      "title",
      theme === "light" ? "Switch to dark theme" : "Switch to light theme"
    );
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the choice just won't stick */
    }
  }

  function initTheme() {
    let saved = "dark";
    try {
      saved = localStorage.getItem(THEME_KEY) || "dark";
    } catch {
      /* ignore */
    }
    applyTheme(saved);
    $("#theme-btn").addEventListener("click", () => {
      const next =
        document.documentElement.getAttribute("data-theme") === "light"
          ? "dark"
          : "light";
      applyTheme(next);
    });
  }

  // --- routing ------------------------------------------------------------

  const VIEWS = {};
  let currentView = null;

  function setSidebar(open) {
    $(".sidebar").classList.toggle("open", open);
    $("#sidebar-backdrop").classList.toggle("open", open);
    $("#menu-btn").setAttribute("aria-expanded", String(open));
    $("#menu-btn").setAttribute(
      "aria-label",
      open ? "Close navigation" : "Open navigation"
    );
  }

  function show(name) {
    const target = VIEWS[name] ? name : "overview";
    currentView = target;

    $$(".view").forEach((view) =>
      view.classList.toggle("active", view.id === `view-${target}`)
    );
    $$(".nav a").forEach((link) => {
      const active = link.dataset.view === target;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("#page-title").textContent = VIEWS[target].title;
    setSidebar(false);

    VIEWS[target].load();
  }

  function initRouting() {
    $$(".nav a").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        window.location.hash = link.dataset.view;
      });
    });

    window.addEventListener("hashchange", () =>
      show(window.location.hash.slice(1))
    );
    $("#menu-btn").addEventListener("click", () =>
      setSidebar(!$(".sidebar").classList.contains("open"))
    );
    $("#sidebar-backdrop").addEventListener("click", () => setSidebar(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setSidebar(false);
    });
    $("#refresh-btn").addEventListener("click", () => {
      VIEWS[currentView].load();
      loadStats();
    });
  }

  // --- connection status --------------------------------------------------
  //
  // The backend owns the session (src/core/session.js); this file only draws
  // what it reports. Nothing here starts, stops or retries a connection on its
  // own, and closing this tab does not touch the bot.

  // What each backend state looks like: the pill class, the label, and the
  // sentence under the Connection card's heading.
  const SESSION_LABELS = {
    idle: { tone: "off", label: "Not started", tag: "danger", tagText: "Not started" },
    starting: { tone: "warn", label: "Connecting", tag: "warn", tagText: "Connecting" },
    waiting_for_qr: { tone: "warn", label: "Waiting for scan", tag: "warn", tagText: "Waiting for scan" },
    linking: { tone: "warn", label: "Linking", tag: "warn", tagText: "Linking" },
    connected: { tone: "on", label: "Connected", tag: "ok", tagText: "Linked" },
    reconnecting: { tone: "warn", label: "Reconnecting", tag: "warn", tagText: "Reconnecting" },
    disconnected: { tone: "off", label: "Disconnected", tag: "danger", tagText: "Disconnected" },
    retry_exhausted: { tone: "off", label: "Disconnected", tag: "danger", tagText: "Gave up reconnecting" },
    logged_out: { tone: "off", label: "Not linked", tag: "danger", tagText: "Not linked" },
    error: { tone: "off", label: "Error", tag: "danger", tagText: "Error" },
  };

  const describeSession = (state) =>
    SESSION_LABELS[state] || { tone: "off", label: "Disconnected", tag: "danger", tagText: "Disconnected" };

  // The last snapshot the backend sent. Every renderer reads this rather than
  // its own idea of what is going on, so the pill and the Connection card can
  // never disagree.
  let sessionSnapshot = null;

  function setStatus(snapshot) {
    if (!snapshot) return;
    sessionSnapshot = snapshot;
    const look = describeSession(snapshot.state);
    const pill = $("#status-pill");
    pill.className = `pill ${look.tone}`;
    pill.innerHTML = `<span class="dot"></span>${esc(look.label)}`;
    // Outside the `currentView` check: leaving the Connection screen while a
    // reconnect was pending used to leave the ticker running for the life of
    // the page, because only renderConnection() could ever stop it.
    syncRetryTicker(snapshot);
    if (currentView === "connection") renderConnection();
  }

  // --- overview -----------------------------------------------------------

  async function loadStats() {
    const { stats } = await api("/stats");

    // /stats carries the same session snapshot the socket pushes, so the poll
    // that runs every 15s refreshes the pill instead of flattening whatever the
    // last live event put there.
    setStatus(stats.connection);

    const cards = [
      ["Groups", stats.totalGroups, "Communities", '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19a6 6 0 0 1 12 0M15 19a5 5 0 0 1 6-4"/></svg>'],
      ["Commands", stats.commandCount, "Available", '<svg viewBox="0 0 24 24"><path d="m5 7 5 5-5 5M12 17h7"/></svg>'],
      ["Open debts", stats.totalDebts, "Unsettled", '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/></svg>'],
      ["Warnings", stats.totalWarnings, "Issued", '<svg viewBox="0 0 24 24"><path d="M12 4 3 20h18zM12 9v5M12 17h.01"/></svg>'],
      ["Notes", stats.totalNotes, "Saved", '<svg viewBox="0 0 24 24"><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/></svg>'],
      ["Todo lists", stats.totalTodos, "Tracked", '<svg viewBox="0 0 24 24"><path d="m5 7 2 2 4-4M13 7h6M5 14l2 2 4-4M13 14h6"/></svg>'],
    ];

    $("#stat-cards").innerHTML = cards
      .map(
        ([label, value, caption, icon]) => `
        <div class="stat">
          <div class="stat-top">
            <span class="stat-icon" aria-hidden="true">${icon}</span>
            <span class="label">${esc(label)}</span>
          </div>
          <div class="value">${esc(value ?? 0)}</div>
          <div class="stat-foot"><span>${esc(caption)}</span><i aria-hidden="true"></i></div>
        </div>`
      )
      .join("");

    const rows = [
      ["WhatsApp account", stats.botNumber ? shortJid(stats.botNumber) : "Not linked"],
      ["Command prefix", stats.prefix],
      ["AI key", stats.aiConfigured ? "Configured" : "Not set"],
      ["Database", stats.database ? "Connected" : "Down"],
      ["Uptime", humanUptime(stats.uptime)],
      ["Memory", `${(stats.memory.heapUsed / 1048576).toFixed(0)} MB`],
      ["Node", stats.nodeVersion],
    ];

    $("#overview-info").innerHTML = rows
      .map(
        ([label, value]) => `
        <div class="runtime-item">
          <div class="runtime-label">${esc(label)}</div>
          <div class="runtime-value">${esc(value)}</div>
        </div>`
      )
      .join("");
  }

  VIEWS.overview = {
    title: "Overview",
    load: guard(loadStats),
  };

  // --- connection ---------------------------------------------------------

  let qrRendered = null;

  function renderQr(text) {
    if (!text || qrRendered === text) return;
    qrRendered = text;

    const frame = $("#qr-frame");
    frame.innerHTML = "";
    // eslint-disable-next-line no-undef
    new QRCode(frame, {
      text,
      width: 240,
      height: 240,
      correctLevel: QRCode.CorrectLevel.H,
    });
    $("#qr-note").textContent = "Scan it from WhatsApp → Linked devices.";
  }

  function clearQr() {
    qrRendered = null;
    $("#qr-frame").innerHTML = "";
    $("#qr-note").textContent = "Waiting for a QR code…";
  }

  function retryHint(snapshot) {
    if (snapshot.state !== "reconnecting" || !snapshot.nextRetryAt) return "";
    const seconds = Math.max(0, Math.round((snapshot.nextRetryAt - Date.now()) / 1000));
    return ` Next attempt in ${seconds}s.`;
  }

  // A countdown that only ticks while there is one to show. Rendering it once
  // and leaving it would put a number on screen that stops being true a second
  // later.
  let retryTicker = null;

  function syncRetryTicker(snapshot) {
    const counting = snapshot.state === "reconnecting" && snapshot.nextRetryAt;
    if (counting && !retryTicker) {
      retryTicker = setInterval(() => {
        if (currentView === "connection") renderConnection();
      }, 1000);
    } else if (!counting && retryTicker) {
      clearInterval(retryTicker);
      retryTicker = null;
    }
  }

  /** Draw the Connection card from the last snapshot. No network call. */
  function renderConnection() {
    const snapshot = sessionSnapshot;
    if (!snapshot) return;

    const look = describeSession(snapshot.state);
    const who = snapshot.user?.id ? shortJid(snapshot.user.id) : "";

    $("#conn-state").innerHTML =
      `<span class="tag ${esc(look.tag)}">${esc(look.tagText)}</span>` +
      (who ? ` <span class="hint">${esc(who)}</span>` : "");

    $("#conn-detail").textContent = (snapshot.detail || "") + retryHint(snapshot);

    // The proxy line, and the one action that can apply a changed one. The
    // label is already redacted server-side — there is no password to leak
    // here because the browser was never told it.
    const proxyLine = $("#conn-proxy");
    if (snapshot.proxy) {
      proxyLine.textContent = `Connecting through ${snapshot.proxy}.`;
    } else if (snapshot.connected || snapshot.state === "waiting_for_qr") {
      proxyLine.textContent = "Connecting directly, with no proxy.";
    } else {
      proxyLine.textContent = "";
    }
    if (snapshot.proxyChanged) {
      proxyLine.textContent +=
        " The saved proxy settings differ from the connection in use — reconnect to apply them.";
    }

    // Only offered when it would do something: there has to be a live session
    // to replace, and a reason to replace it.
    const canReconnect = snapshot.canStop && snapshot.proxyChanged;
    $("#reconnect-btn").style.display = canReconnect ? "" : "none";
    $("#reconnect-btn").disabled = !canReconnect;

    // Buttons follow the backend, so a state that cannot accept an action
    // cannot be asked for one.
    $("#start-btn").disabled = !snapshot.canStart;
    $("#start-btn").textContent =
      snapshot.state === "logged_out" || snapshot.state === "idle"
        ? "Start session"
        : "Retry connection";
    $("#stop-btn").disabled = !snapshot.canStop;
    // Not "only while connected": a refused pairing leaves dead credentials
    // that can only be cleared by unlinking.
    $("#unlink-btn").disabled = !snapshot.canUnlink;

    // The QR frame is only up while a code can actually be scanned.
    const pairing = snapshot.state === "waiting_for_qr";
    $("#qr-panel").style.display = pairing ? "block" : "none";
    if (!pairing) clearQr();
  }

  VIEWS.connection = {
    title: "Connection",
    // One request for the whole screen, including a QR that was already on
    // offer before this tab existed — a reload has to show the real backend
    // state, not an empty frame.
    load: guard(async () => {
      const { session, qr } = await api("/bot/session");
      setStatus(session);
      renderConnection();
      if (qr && session.state === "waiting_for_qr") renderQr(qr);
    }),
  };

  function confirmed(question, fn) {
    return guard(async () => {
      if (!confirm(question)) return;
      await fn();
    });
  }

  function initConnectionActions() {
    // Starting is idempotent on the server: a second click while a socket is
    // being made is answered with the state it is already in.
    $("#start-btn").addEventListener(
      "click",
      guard(async () => {
        // Disabled straight away so an impatient second click cannot even be
        // made, and put back from the backend's answer either way — a failed
        // request must not leave a dead button behind.
        $("#start-btn").disabled = true;
        try {
          const { session } = await api("/bot/session/start", { method: "POST" });
          setStatus(session);
          toast("Session starting…", "ok");
        } finally {
          renderConnection();
        }
      })
    );

    $("#reconnect-btn").addEventListener(
      "click",
      confirmed(
        "Reconnect WhatsApp now to apply the saved settings? The bot stops answering for a few seconds.",
        async () => {
          const { session } = await api("/bot/session/reconnect", { method: "POST" });
          setStatus(session);
          toast("Reconnecting with the new settings…", "ok");
        }
      )
    );

    $("#stop-btn").addEventListener(
      "click",
      confirmed(
        "Stop the WhatsApp session? The bot stops answering until you start it again. The pairing is kept.",
        async () => {
          const { session } = await api("/bot/session/stop", { method: "POST" });
          setStatus(session);
          toast("Session stopped.", "ok");
        }
      )
    );

    $("#unlink-btn").addEventListener(
      "click",
      confirmed(
        "Unlink this WhatsApp account? The bot stops answering until you start a new session and scan a QR code.",
        async () => {
          const { session } = await api("/bot/logout", { method: "POST" });
          setStatus(session);
          toast("Unlinked. Press Start session to pair again.", "ok");
        }
      )
    );

    $("#restart-btn").addEventListener(
      "click",
      confirmed(
        "Restart the bot? It only comes back on its own if it runs under a supervisor (pm2, systemd, Docker).",
        async () => {
          const data = await api("/bot/restart", { method: "POST" });
          toast(data.message || "Restarting…", "ok");
        }
      )
    );
  }

  // --- commands -----------------------------------------------------------

  let commandCache = [];

  function commandRow(command, levels) {
    const permissionCell = command.permissionLocked
      ? `<span class="locked" title="This command calls a WhatsApp admin action, so it always requires a group admin.">🔒 Group admin</span>`
      : `<select data-cmd="${esc(command.name)}" data-field="permission">
           ${levels
             .map(
               (level) =>
                 `<option value="${esc(level)}"${level === command.permission ? " selected" : ""}>${esc(
                   level.replace("_", " ").toLowerCase()
                 )}</option>`
             )
             .join("")}
         </select>`;

    return `
      <tr>
        <td>
          <div class="cmd-name">${esc(command.name)}</div>
          <div class="hint">${esc(command.description || "")}</div>
        </td>
        <td>${command.category === "group" ? '<span class="tag info">group</span>' : '<span class="tag">general</span>'}</td>
        <td>
          <input type="text" class="alias-input" value="${esc(command.aliases.join(", "))}"
                 data-cmd="${esc(command.name)}" data-field="aliases"
                 placeholder="no aliases" />
        </td>
        <td>${permissionCell}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-cmd="${esc(command.name)}" data-field="enabled"
                   ${command.enabled ? "checked" : ""} />
            <span class="track"></span>
          </label>
        </td>
      </tr>`;
  }

  function renderCommands() {
    const query = $("#cmd-search").value.trim().toLowerCase();
    const category = $("#cmd-filter").value;

    const rows = commandCache.commands.filter((command) => {
      if (category !== "all" && command.category !== category) return false;
      if (!query) return true;
      return (
        command.name.includes(query) ||
        command.aliases.some((alias) => alias.includes(query)) ||
        (command.description || "").toLowerCase().includes(query)
      );
    });

    $("#cmd-body").innerHTML = rows.length
      ? rows.map((command) => commandRow(command, commandCache.levels)).join("")
      : `<tr><td colspan="5"><div class="empty">Nothing matches that.</div></td></tr>`;
  }

  const patchCommand = guard(async (name, patch) => {
    const { command } = await api(`/commands/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: patch,
    });
    const index = commandCache.commands.findIndex((entry) => entry.name === name);
    if (index !== -1) commandCache.commands[index] = command;
    toast(`!${name} updated`, "ok");
  });

  VIEWS.commands = {
    title: "Commands",
    load: guard(async () => {
      commandCache = await api("/commands");
      $("#prefix-input").value = commandCache.prefix;
      renderCommands();
    }),
  };

  function initCommandActions() {
    $("#cmd-search").addEventListener("input", renderCommands);
    $("#cmd-filter").addEventListener("change", renderCommands);

    $("#prefix-save").addEventListener(
      "click",
      guard(async () => {
        const value = $("#prefix-input").value.trim();
        await api("/settings", { method: "PATCH", body: { key: "prefix", value } });
        toast(`Prefix is now "${value}"`, "ok");
        VIEWS.commands.load();
      })
    );

    // One listener for the whole table: the rows are re-rendered on every
    // search keystroke, so per-row handlers would have to be re-attached.
    const table = $("#cmd-body");

    table.addEventListener("change", (event) => {
      const target = event.target;
      const name = target.dataset?.cmd;
      if (!name) return;

      if (target.dataset.field === "permission") {
        patchCommand(name, { permission: target.value });
      } else if (target.dataset.field === "enabled") {
        patchCommand(name, { enabled: target.checked });
      } else if (target.dataset.field === "aliases") {
        const aliases = target.value
          .split(",")
          .map((alias) => alias.trim())
          .filter(Boolean);
        patchCommand(name, { aliases }).then(() => VIEWS.commands.load());
      }
    });
  }

  // --- AI -----------------------------------------------------------------

  let memoryScope = null;

  VIEWS.ai = {
    title: "AI",
    load: guard(async () => {
      const [{ persona }, { scopes }] = await Promise.all([
        api("/ai/persona"),
        api("/ai/memory"),
      ]);

      $("#persona-body").value = persona.body;
      $("#persona-file").textContent = persona.file;

      $("#memory-list").innerHTML = scopes.length
        ? scopes
            .map(
              (entry) => `
          <button class="btn btn-sm" type="button" data-scope="${esc(entry.scope)}">
            ${entry.scope === "global" ? "🌍" : "💬"} ${esc(entry.label)}
            <span class="hint">${esc(entry.entries)} entries</span>
          </button>`
            )
            .join("")
        : `<div class="hint">No memory files yet. The bot writes one the first time someone asks it to remember something.</div>`;

      if (memoryScope && !scopes.some((entry) => entry.scope === memoryScope)) {
        memoryScope = null;
        $("#memory-editor").style.display = "none";
      }
    }),
  };

  const openMemory = guard(async (scope) => {
    const { content } = await api(`/ai/memory/${encodeURIComponent(scope)}`);
    memoryScope = scope;
    $("#memory-editor").style.display = "block";
    $("#memory-scope").textContent = scope;
    $("#memory-content").value = content;
  });

  function initAiActions() {
    $("#persona-save").addEventListener(
      "click",
      guard(async () => {
        await api("/ai/persona", {
          method: "PUT",
          body: { body: $("#persona-body").value },
        });
        toast("System prompt saved — it applies to the next message.", "ok");
      })
    );

    $("#memory-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-scope]");
      if (button) openMemory(button.dataset.scope);
    });

    $("#memory-save").addEventListener(
      "click",
      guard(async () => {
        await api(`/ai/memory/${encodeURIComponent(memoryScope)}`, {
          method: "PUT",
          body: { content: $("#memory-content").value },
        });
        toast("Memory saved", "ok");
        VIEWS.ai.load();
      })
    );

    $("#memory-delete").addEventListener(
      "click",
      guard(async () => {
        if (!confirm(`Delete the memory file for ${memoryScope}? This can't be undone.`)) {
          return;
        }
        await api(`/ai/memory/${encodeURIComponent(memoryScope)}`, {
          method: "DELETE",
        });
        memoryScope = null;
        $("#memory-editor").style.display = "none";
        toast("Memory file deleted", "ok");
        VIEWS.ai.load();
      })
    );
  }

  // --- groups -------------------------------------------------------------

  function groupCard(group) {
    const id = esc(group.id);
    const title = esc(group.subject || group.id);
    const members =
      group.participants === null ? "" : `<span class="tag">${group.participants} members</span>`;

    const toggle = (field, label, checked) => `
      <label class="switch" style="margin-bottom:9px">
        <input type="checkbox" data-group="${id}" data-field="${field}" ${checked ? "checked" : ""} />
        <span class="track"></span>
        <span>${esc(label)}</span>
      </label>`;

    return `
      <details class="card group-card">
        <summary>
          <span>${title}</span>
          ${members}
          ${group.antilink.enabled ? '<span class="tag warn">antilink</span>' : ""}
          ${group.antispam.enabled ? '<span class="tag warn">antispam</span>' : ""}
          <span class="chev">›</span>
        </summary>

        <div class="group-body">
          <div>
            <h3>Links</h3>
            ${toggle("antilink.enabled", "Block links", group.antilink.enabled)}
            <label class="field">
              <span>Mode</span>
              <select data-group="${id}" data-field="antilink.mode">
                ${["ALL", "WHITELIST", "BLACKLIST"]
                  .map(
                    (mode) =>
                      `<option value="${mode}"${mode === group.antilink.mode ? " selected" : ""}>${mode.toLowerCase()}</option>`
                  )
                  .join("")}
              </select>
            </label>
            <label class="field">
              <span>Allowed domains</span>
              <input type="text" data-group="${id}" data-field="antilink.allowed_domains"
                     value="${esc(group.antilink.allowed_domains.join(", "))}"
                     placeholder="youtube.com, github.com" />
            </label>
          </div>

          <div>
            <h3>Spam</h3>
            ${toggle("antispam.enabled", "Anti-spam", group.antispam.enabled)}
            <label class="field">
              <span>Messages allowed</span>
              <input type="number" min="2" max="100" data-group="${id}" data-field="antispam.message_count"
                     value="${esc(group.antispam.message_count)}" />
            </label>
            <label class="field">
              <span>Within (seconds)</span>
              <input type="number" min="1" max="600" data-group="${id}" data-field="antispam.time_window"
                     value="${esc(group.antispam.time_window)}" />
            </label>
            <label class="field">
              <span>Then</span>
              <select data-group="${id}" data-field="antispam.action">
                ${["WARN", "KICK"]
                  .map(
                    (action) =>
                      `<option value="${action}"${action === group.antispam.action ? " selected" : ""}>${action.toLowerCase()}</option>`
                  )
                  .join("")}
              </select>
            </label>
          </div>

          <div>
            <h3>Media</h3>
            ${toggle("media_control.enabled", "Restrict media", group.media_control.enabled)}
            <div class="hint" style="margin-bottom:6px">Blocked types</div>
            <div class="inline" style="margin-bottom:12px">
              ${["image", "video", "sticker", "audio"]
                .map(
                  (type) => `
                <label class="inline" style="gap:5px">
                  <input type="checkbox" data-group="${id}" data-field="media.${type}"
                         ${group.media_control.blocked_types.includes(type) ? "checked" : ""} />
                  <span class="hint">${type}</span>
                </label>`
                )
                .join("")}
            </div>

            <h3>Joining</h3>
            ${toggle(
              "join_requests.auto_approve_enabled",
              "Auto-approve requests",
              group.join_requests.auto_approve_enabled
            )}
          </div>

          <div>
            <h3>Warnings</h3>
            <label class="field">
              <span>Max warnings</span>
              <input type="number" min="1" max="50" data-group="${id}" data-field="warn_system.max_warnings"
                     value="${esc(group.warn_system.max_warnings)}" />
            </label>
            <label class="field">
              <span>Then</span>
              <select data-group="${id}" data-field="warn_system.action">
                ${["NONE", "KICK"]
                  .map(
                    (action) =>
                      `<option value="${action}"${action === group.warn_system.action ? " selected" : ""}>${action.toLowerCase()}</option>`
                  )
                  .join("")}
              </select>
            </label>

            <h3>Welcome</h3>
            ${toggle("welcome_system.enabled", "Welcome new members", group.welcome_system.enabled)}
          </div>

          <div style="grid-column:1/-1">
            <h3>Rules</h3>
            <textarea data-group="${id}" data-field="rules" style="min-height:110px"
                      placeholder="Shown by !group rules">${esc(group.rules)}</textarea>
          </div>

          <div style="grid-column:1/-1">
            <button class="btn btn-primary" type="button" data-save-group="${id}">Save this group</button>
            <span class="hint" style="margin-left:8px">Blacklisted: ${group.blacklist.length}</span>
          </div>
        </div>
      </details>`;
  }

  // Scoped to the group's own <details> element rather than to a selector
  // built from the JID — a group id is full of characters a CSS selector would
  // have to escape.
  function collectGroupPatch(card) {
    const read = (field) => $(`[data-field="${field}"]`, card);

    const blocked = ["image", "video", "sticker", "audio"].filter(
      (type) => read(`media.${type}`)?.checked
    );

    return {
      antilink: {
        enabled: read("antilink.enabled").checked,
        mode: read("antilink.mode").value,
        allowed_domains: read("antilink.allowed_domains")
          .value.split(",")
          .map((domain) => domain.trim())
          .filter(Boolean),
      },
      antispam: {
        enabled: read("antispam.enabled").checked,
        message_count: Number(read("antispam.message_count").value),
        time_window: Number(read("antispam.time_window").value),
        action: read("antispam.action").value,
      },
      media_control: {
        enabled: read("media_control.enabled").checked,
        blocked_types: blocked,
      },
      welcome_system: { enabled: read("welcome_system.enabled").checked },
      warn_system: {
        max_warnings: Number(read("warn_system.max_warnings").value),
        action: read("warn_system.action").value,
      },
      join_requests: {
        auto_approve_enabled: read("join_requests.auto_approve_enabled").checked,
      },
      rules: read("rules").value,
    };
  }

  VIEWS.groups = {
    title: "Groups",
    load: guard(async () => {
      const { groups } = await api("/groups");
      $("#groups-list").innerHTML = groups.length
        ? groups.map(groupCard).join("")
        : `<div class="card"><div class="empty">The bot isn't in any group yet.</div></div>`;
    }),
  };

  function initGroupActions() {
    $("#groups-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-save-group]");
      if (!button) return;

      const groupId = button.dataset.saveGroup;
      const card = button.closest("details");
      guard(async () => {
        await api(`/groups/${encodeURIComponent(groupId)}`, {
          method: "PATCH",
          body: collectGroupPatch(card),
        });
        toast("Group settings saved", "ok");
      })();
    });
  }

  // --- data tables --------------------------------------------------------

  const TABLES = {
    debts: {
      endpoint: "/debts",
      key: "debts",
      columns: ["Group", "Debtor", "Creditor", "Amount", "Note", "Status"],
      row: (debt) => [
        `<code>${esc(shortJid(debt.group_id))}</code>`,
        `<code>${esc(shortJid(debt.debtor_id))}</code>`,
        `<code>${esc(shortJid(debt.creditor_id))}</code>`,
        `<strong>${esc(debt.amount)} ${esc(debt.currency || "")}</strong>`,
        `<span class="wrap">${esc(debt.description || "—")}</span>`,
        debt.settled
          ? '<span class="tag ok">settled</span>'
          : '<span class="tag warn">open</span>',
      ],
    },
    warnings: {
      endpoint: "/warnings",
      key: "warnings",
      columns: ["Group", "User", "Count", "Reasons"],
      row: (warning) => [
        `<code>${esc(shortJid(warning.group_id))}</code>`,
        `<code>${esc(shortJid(warning.user_id))}</code>`,
        `<span class="tag warn">${warning.warnings.length}</span>`,
        `<span class="wrap">${esc(
          warning.warnings.map((entry) => entry.reason).join(" · ")
        )}</span>`,
      ],
    },
    notes: {
      endpoint: "/notes",
      key: "notes",
      columns: ["Group", "Keyword", "Text"],
      row: (note) => [
        `<code>${esc(shortJid(note.group_id))}</code>`,
        `<strong>${esc(note.keyword)}</strong>`,
        `<span class="wrap">${esc(String(note.note_text ?? "").slice(0, 160))}</span>`,
      ],
    },
    todos: {
      endpoint: "/todos",
      key: "todos",
      columns: ["User", "Tasks", "Open"],
      row: (todo) => [
        `<code>${esc(shortJid(todo.user_id))}</code>`,
        `<span class="wrap">${esc(
          todo.tasks
            .map((task) => (typeof task === "string" ? task : task.text || ""))
            .join(" · ")
            .slice(0, 160)
        )}</span>`,
        `<span class="tag">${todo.tasks.length}</span>`,
      ],
    },
    schedules: {
      endpoint: "/schedules",
      key: "schedules",
      columns: ["Target", "When", "Message", "Status", ""],
      row: (job) => [
        `<code>${esc(shortJid(job.targetJid))}</code>`,
        job.type === "recurring"
          ? `<code>${esc(job.cronString || "—")}</code>`
          : esc(new Date(job.date).toLocaleString()),
        `<span class="wrap">${esc(String(job.message ?? "").slice(0, 120))}</span>`,
        `<span class="tag${job.status === "active" || job.status === "pending" ? " ok" : ""}">${esc(job.status)}</span>`,
        `<button class="btn btn-sm btn-danger" type="button" data-drop-schedule="${esc(job.id)}">Delete</button>`,
      ],
    },
    users: {
      endpoint: "/users",
      key: "users",
      columns: ["Number", "Name", "Role", "Last seen"],
      row: (user) => [
        `<code>${esc(user.phone || shortJid(user.jid))}</code>`,
        esc(user.displayName || "—"),
        user.isOwner
          ? '<span class="tag info">owner</span>'
          : user.isAdmin
          ? '<span class="tag ok">admin</span>'
          : '<span class="tag">member</span>',
        esc(timeAgo(user.lastSeen)),
      ],
    },
  };

  let dataTab = "debts";

  const loadTable = guard(async () => {
    const table = TABLES[dataTab];
    $("#data-table").innerHTML = `<div class="loading">Loading…</div>`;

    const payload = await api(table.endpoint);
    const rows = payload[table.key] || [];

    $("#data-table").innerHTML = rows.length
      ? `<div class="table-wrap"><table>
           <thead><tr>${table.columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead>
           <tbody>${rows
             .map((row) => `<tr>${table.row(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
             .join("")}</tbody>
         </table></div>`
      : `<div class="empty">Nothing here yet.</div>`;
  });

  VIEWS.data = {
    title: "Data",
    load: loadTable,
  };

  function initDataActions() {
    $("#data-table").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drop-schedule]");
      if (!button) return;
      guard(async () => {
        await api(`/schedules/${encodeURIComponent(button.dataset.dropSchedule)}`, {
          method: "DELETE",
        });
        toast("Schedule deleted", "ok");
        loadTable();
      })();
    });

    $("#data-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-table]");
      if (!button) return;
      dataTab = button.dataset.table;
      $$("#data-tabs .btn").forEach((tab) => {
        const active = tab.dataset.table === dataTab;
        tab.classList.toggle("btn-primary", active);
        tab.setAttribute("aria-selected", String(active));
      });
      loadTable();
    });
  }

  // --- roles --------------------------------------------------------------

  function roleRows(list, role) {
    if (!list.length) {
      return `<tr><td colspan="3"><div class="empty">No ${role}s yet.</div></td></tr>`;
    }
    return list
      .map(
        (user) => `
      <tr>
        <td><code>${esc(user.phone || shortJid(user.jid))}</code></td>
        <td>${esc(user.displayName || "—")}</td>
        <td>
          <button class="btn btn-sm btn-danger" type="button" data-revoke="${esc(user.phone || shortJid(user.jid))}"
                  data-role="${esc(role)}">Revoke</button>
        </td>
      </tr>`
      )
      .join("");
  }

  VIEWS.roles = {
    title: "Roles",
    load: guard(async () => {
      const { roles } = await api("/roles");
      $("#owners-body").innerHTML = roleRows(roles.owners, "owner");
      $("#admins-body").innerHTML = roleRows(roles.admins, "admin");
    }),
  };

  function initRoleActions() {
    $("#role-add").addEventListener(
      "click",
      guard(async () => {
        const target = $("#role-number").value.trim();
        const role = $("#role-kind").value;
        await api("/roles", { method: "POST", body: { target, role, action: "grant" } });
        $("#role-number").value = "";
        toast(`Added as ${role}`, "ok");
        VIEWS.roles.load();
      })
    );

    $("#view-roles").addEventListener("click", (event) => {
      const button = event.target.closest("[data-revoke]");
      if (!button) return;
      guard(async () => {
        await api("/roles", {
          method: "POST",
          body: {
            target: button.dataset.revoke,
            role: button.dataset.role,
            action: "revoke",
          },
        });
        toast("Revoked", "ok");
        VIEWS.roles.load();
      })();
    });
  }

  // --- settings -----------------------------------------------------------

  function settingField(setting) {
    const id = `set-${setting.key}`;
    const source =
      setting.source === "dashboard"
        ? '<span class="source dashboard">saved here</span>'
        : '<span class="source">default</span>';
    const restart = setting.restart
      ? '<span class="source">restart to apply</span>'
      : "";

    let control;
    if (setting.type === "secret") {
      control = `
        <div class="inline">
          <input type="password" id="${id}" placeholder="${setting.configured ? "•••••••• (set)" : "not set"}"
                 autocomplete="new-password"${setting.configured ? ' data-configured="1"' : ""} />
          <button class="btn btn-sm" type="button" data-save-setting="${esc(setting.key)}">Save</button>
          ${setting.configured ? `<button class="btn btn-sm btn-danger" type="button" data-clear-setting="${esc(setting.key)}">Clear</button>` : ""}
        </div>`;
    } else if (setting.type === "bool") {
      control = `
        <div class="inline">
          <label class="switch">
            <input type="checkbox" id="${id}" ${setting.value ? "checked" : ""} />
            <span class="track"></span>
          </label>
          <button class="btn btn-sm" type="button" data-save-setting="${esc(setting.key)}">Save</button>
        </div>`;
    } else if (Array.isArray(setting.choices) && setting.choices.length) {
      control = `
        <div class="inline">
          <select id="${id}">
            ${setting.choices
              .map(
                (choice) =>
                  `<option value="${esc(choice)}"${choice === setting.value ? " selected" : ""}>${esc(choice)}</option>`
              )
              .join("")}
          </select>
          <button class="btn btn-sm" type="button" data-save-setting="${esc(setting.key)}">Save</button>
        </div>`;
    } else {
      control = `
        <div class="inline">
          <input type="${setting.type === "int" ? "number" : "text"}" id="${id}"
                 value="${esc(setting.value)}"
                 ${setting.min !== null ? `min="${setting.min}"` : ""}
                 ${setting.max !== null ? `max="${setting.max}"` : ""} />
          <button class="btn btn-sm" type="button" data-save-setting="${esc(setting.key)}">Save</button>
        </div>`;
    }

    return `
      <div class="setting-item">
        <div class="inline setting-label-row">
          <label for="${id}" class="setting-label">${esc(setting.label)}</label>
          ${source}${restart}
        </div>
        ${control}
        ${setting.hint ? `<div class="hint setting-hint">${esc(setting.hint)}</div>` : ""}
      </div>`;
  }

  VIEWS.settings = {
    title: "Settings",
    load: guard(async () => {
      const { settings } = await api("/settings");

      const groups = new Map();
      for (const setting of settings) {
        if (!groups.has(setting.group)) {
          groups.set(setting.group, { label: setting.groupLabel, items: [] });
        }
        groups.get(setting.group).items.push(setting);
      }

      $("#settings-list").innerHTML = [...groups.values()]
        .map(
          (group) => `
        <div class="card">
          <div class="card-head"><h2>${esc(group.label)}</h2></div>
          ${group.items.map(settingField).join("")}
        </div>`
        )
        .join("");
    }),
  };

  function initSettingsActions() {
    $("#pw-save").addEventListener(
      "click",
      guard(async () => {
        const current = $("#pw-current").value;
        const next = $("#pw-next").value;
        await api("/security/password", { method: "POST", body: { current, next } });
        $("#pw-current").value = "";
        $("#pw-next").value = "";
        toast("Password changed", "ok");
      })
    );

    $("#settings-list").addEventListener("click", (event) => {
      const save = event.target.closest("[data-save-setting]");
      const clear = event.target.closest("[data-clear-setting]");
      if (!save && !clear) return;

      const key = save ? save.dataset.saveSetting : clear.dataset.clearSetting;
      const input = document.getElementById(`set-${key}`);

      // An already-set secret with an empty box means "leave it alone", not
      // "erase it". The box is always empty — the server never sends the value
      // back — so saving the field as-is would wipe a working password every
      // time somebody edited the host next to it. Clear is the explicit way.
      if (save && input.dataset.configured === "1" && input.value === "") {
        toast("Left unchanged. Use Clear to remove it.");
        return;
      }

      const value = clear
        ? ""
        : input.type === "checkbox"
        ? input.checked
        : input.value;

      guard(async () => {
        await api("/settings", { method: "PATCH", body: { key, value } });
        toast(clear ? "Cleared" : "Saved", "ok");
        VIEWS.settings.load();
        // A proxy change cannot reach a socket that is already open; the
        // Connection screen is where that is offered, so refresh its state.
        if (key.startsWith("whatsapp_proxy_")) loadStats().catch(() => {});
      })();
    });
  }

  // --- boot ---------------------------------------------------------------

  // The socket is a one-way feed of what the backend is already doing. Opening
  // it, losing it or reloading the page changes nothing about the WhatsApp
  // session; a reconnect happens in the backend with every tab shut.
  function initSocket() {
    // eslint-disable-next-line no-undef
    const socket = io();

    socket.on("session", (snapshot) => setStatus(snapshot));

    socket.on("qr", (qr) => {
      renderQr(qr);
      if (currentView !== "connection") {
        toast("A new QR code is ready — open Connection to scan it.");
      }
    });

    socket.on("qr_cleared", () => clearQr());

    // A socket that dropped may have missed transitions while it was away.
    socket.on("connect", () => {
      if (currentView === "connection") VIEWS.connection.load();
      else loadStats().catch(() => {});
    });
  }

  initTheme();
  initRouting();
  initConnectionActions();
  initCommandActions();
  initAiActions();
  initGroupActions();
  initDataActions();
  initRoleActions();
  initSettingsActions();
  initSocket();

  show(window.location.hash.slice(1));
  loadStats().catch(() => {});
  setInterval(() => loadStats().catch(() => {}), 15000);
})();
