# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Levix** — a self-hosted personal WhatsApp bot built with Node.js and
**Baileys v7**: a command system (55 commands), group moderation, an AI agent
on Google Gemini, scheduled messages, and a web control panel that changes
almost all of it live. The database is the source of truth and the panel is how
you edit it: there is no `.env`, no config file, and nothing to install beside
Node.

The name ("Levix") and the credit ("built by Abdelrhman Diab, Leviro") are
**not** settings. `src/config/brand.cjs` holds what the UI renders (name,
tagline, credit, repo) and is frozen. The AI's product-identity block is a
separate, code-owned module — `src/config/ai-identity.cjs` — prepended to the
system instruction above the editable persona on every request, so no prompt
edit and no message from a user can make the bot claim a different name or
author. Nothing imports that module except the AI: no route, no template, no
setting, and no dashboard field. It is not secret (this is an open-source
project); it is simply not operator-configurable.

## Technology Stack

- **Core**: Node.js 24+ with ES Modules (`"type": "module"`)
- **WhatsApp**: `@whiskeysockets/baileys@7.0.0-rc14` (ESM)
- **Database**: SQLite through **`node:sqlite`** — Node's own module, so the
  datastore costs zero dependencies and there is no server to install
- **AI**: `@google/generative-ai` (Gemini API)
- **Web Server**: Express.js (the control panel)
- **Logging**: Pino with pino-pretty
- **Scheduling**: `node-cron`

There is **no `.env` file, no config file and no external database**. See
"Configuration" below.

## Important: Mixed Module System

This codebase uses **both ESM and CommonJS**:
- **ESM**: `src/index.js`, `src/core/`, `src/handlers/`, `src/middleware/`, `src/routes/`, ESM utilities (`*.esm.js`)
- **CommonJS**: `app.cjs`, `scheduler.cjs`, `src/commands/`, most `src/utils/`, `src/db/store.cjs`

When importing:
- ESM files: Use `import` syntax
- CommonJS files in ESM context: Use `createRequire` pattern (see `src/index.js:14`)
- Never mix module systems without proper bridging

## Commands to Run

### Development
```bash
npm start        # node bin/levix.js — data lands in ./data
npm run dev      # same, under nodemon
npm test         # the whole suite (tests/run.mjs)

node bin/levix.js headless         # the bot with no panel and no open port
node bin/levix.js where            # print the data directory
node bin/levix.js reset-password   # forget the panel password (WhatsApp link untouched)
sudo node bin/levix.js domain bot.example.com   # reverse proxy + HTTPS
```

### Validating a distribution
```bash
npm run validate:tarball   # pack, install into a clean prefix, boot it
npm run validate:sea       # build the executable, run it with no source tree
npm run validate:docker    # build, start, claim, restart, upgrade the volume
```
These exercise the built artifact, not the checkout — that is the point of
them. CI runs all three and gates a release on the result.

### Database Inspection
```bash
# The database is one file inside the data directory
sqlite3 "$(node bin/levix.js where)/levix.db" ".tables"

# LID mappings (Baileys v7 feature)
sqlite3 "$(node bin/levix.js where)/levix.db" "SELECT * FROM lid_mapping LIMIT 10;"

# What the dashboard has saved
sqlite3 "$(node bin/levix.js where)/levix.db" "SELECT key, value FROM bot_settings;"
```

### Packaging
```bash
npm run build:sea     # single executable in build/ (needs esbuild + postject)
docker compose up -d  # container, data in the levix-data volume
```
See `PACKAGING.md`.

### Server Access
The control panel is the only surface and it is always on.

- Control panel: `http://localhost:3001/` — port is a setting in the database
- First run: `/setup` chooses the password (from another machine it also wants
  the setup code printed in the terminal)
- QR pairing: `/qr`, behind the login, same for the socket.io channel that
  pushes QR refreshes
- Dashboard API: `http://localhost:3001/dashboard/api/*` — behind the session

## Architecture

### Directory Structure
```
bin/levix.js          # the `levix` command (start · where · reset-password)
app.cjs               # the control panel's HTTP surface
scheduler.cjs         # cron + one-off scheduled messages
src/
├── commands/          # Command handlers (CommonJS)
│   ├── *.cjs         # Top-level commands (gemini, ping, etc.)
│   └── group/        # Group sub-commands (kick, promote, etc.)
├── config/           # Configuration
│   ├── paths.cjs     # THE data directory + the read-only asset root
│   ├── secrets.cjs   # generated session key · password hash · setup code
│   ├── settings.cjs  # every operator-changeable value: database -> default
│   ├── defaults.cjs  # shipped command permissions + prefix (was config.json)
│   ├── runtime-config.cjs # defaults.cjs + dashboard overrides
│   ├── brand.cjs     # name + credit for the UI (FROZEN, public)
│   ├── brand.esm.js  # ESM face of brand.cjs
│   ├── ai-identity.cjs # product identity for the MODEL only (code-owned,
│   │                 # not a setting, not reachable from any route or view)
│   ├── ai-persona.md # the editable AI system prompt (a TEMPLATE — the live
│   │                 # copy lives in the data directory)
│   ├── constants.js  # build-time constants (retries, cache TTLs)
│   └── baileys.config.js # Baileys socket configuration (ESM)
├── db/               # The database
│   ├── db.cjs        # opens levix.db, schema + migrations, statement cache
│   ├── store.cjs     # every query, synchronous
│   └── store.esm.js  # ESM face of store.cjs (lifecycle)
├── core/             # Core WhatsApp functionality (ESM)
│   ├── socket.js     # WhatsApp socket creation
│   ├── events.js     # Event listener setup
│   ├── session.js    # THE session state machine: start/stop/logout, retries
│   └── connection.js # classifyDisconnect() + what happens once open
├── handlers/         # Message routing (ESM)
│   ├── message.handler.js  # Main message router
│   ├── command.handler.js  # Command dispatcher + loader
│   └── group.handler.js    # Group events (join/leave)
├── middleware/       # Message filtering (ESM)
│   ├── antispam.middleware.js
│   ├── blacklist.middleware.js
│   ├── permissions.middleware.js
│   └── forward-tracking.middleware.js
├── routes/
│   └── dashboard.api.esm.js # everything the control panel reads/writes
├── services/         # External services
│   ├── aiAgent.cjs   # Gemini agent loop (tools + memory + live status)
│   └── aiTools.cjs   # The tools the agent can call
└── utils/            # Utility functions (Mixed)
    ├── memory.cjs    # Long-term memory as Markdown files
    ├── statusMessage.cjs # One message per command, edited in place
    ├── textDecode.cjs    # charset / entity / mojibake decoding
    ├── logger.cjs    # Pino (worker transports, or in-process when packaged)
    ├── storage.cjs   # Sync storage API (CommonJS) — re-exports src/db/store.cjs
    ├── storage.esm.js # Same API for ESM callers
    ├── storage-hub.*  # AI conversation history (async signatures)
    └── normalizeJid.esm.js # JID/LID utilities
```

Outside `src/`:

```
views/            # login.ejs · setup.ejs · dashboard.ejs · qr.ejs
public/           # dashboard.css · dashboard.js · qrcode.min.js · socket.io.min.js
public/brand/     # generated logo files (committed)
deploy/           # install.sh · levix.service · nginx/ (reference config)
scripts/          # build-brand-assets.mjs · build-sea.mjs · release installer
Dockerfile · docker-compose.yml
data/             # created at runtime, gitignored (or ~/.levix)
```

### Startup

Two shapes, one core. The difference is which bootstrap runs, not a flag
threaded through the codebase:

```
levix                                levix headless
  bootstrapCore({ autoStart: false })  bootstrapCore({ autoStart: true })
  bootstrapPanel()
  maybe open a browser
```

**Starting the process does not start WhatsApp.** In panel mode the session
sits `idle` until somebody presses Start on the Connection screen. Headless has
no screen and nobody to press anything, so it asks for `autoStart`. That one
option is the entire difference — there is no `if (headless)` in `src/core/`.

- `src/cli.js` — the command line. Every branch imports only what it needs, so
  `where` never opens a database and `reset-password` never starts WhatsApp.
  `bin/levix.js` is a two-line wrapper, and the packaged executable bundles the
  same file.
- `src/bootstrap/core.js` — lock, database, commands, the session manager,
  the scheduler. It *builds* the WhatsApp session; it only *starts* it when
  asked.
- `src/bootstrap/panel.js` — Express, sessions, EJS, socket.io, routes, listen.
  Requiring `app.cjs` is what *constructs* the panel, so it happens here and
  nowhere else; headless never imports this file.
- `src/bootstrap/events.cjs` — the hub the bot reports into. The session
  manager emits into it; the panel forwards everything to socket.io and
  headless prints the lines a person waiting at a terminal cares about. The hub
  is one-way: nothing that listens can emit back into the bot, which is what
  keeps a browser attaching or leaving from touching the connection.

### The WhatsApp session (`src/core/session.js`)

One backend-owned state machine, and the only thing in the codebase allowed to
create or destroy a Baileys socket. The panel *displays* it and asks it to
change; socket.io clients opening, closing or refreshing have no effect on it.

```
idle -> starting -> waiting_for_qr -> linking -> connected
                                                    |
                     reconnecting <-----------------+
                          |
   disconnected · retry_exhausted · logged_out · error
```

| state | meaning |
| --- | --- |
| `idle` | nothing running. Panel mode boots here. |
| `starting` | a socket is being created right now. |
| `waiting_for_qr` | unpaired: a code is out, waiting for a phone. |
| `linking` | the code was scanned; WhatsApp wants the socket remade. |
| `connected` | open. |
| `reconnecting` | recoverable close; a retry is scheduled. |
| `disconnected` | closed, not retrying, startable by hand. |
| `retry_exhausted` | the schedule ran out. Levix keeps running. |
| `logged_out` | WhatsApp dropped the pairing; credentials were cleared. |
| `error` | creating the socket threw. |

**Reconnect policy — staged linear backoff, not exponential.** Attempt N waits
`N * 5s`: **5, 10, 15, 20, 25**, then stop (`RETRY_SCHEDULE_MS` in
`src/config/constants.js`). The counter resets to zero on every `open`. Exactly
one retry timer exists at a time, and it is deliberately **not** `unref`ed —
once the WhatsApp socket is gone a headless Levix has nothing else holding the
event loop open, so an unref'd timer would let the process fall out during the
wait instead of reconnecting. Shutdown cancels it explicitly, so keeping it
ref'd cannot delay a SIGTERM. It works with zero dashboards open, because the
backend owns it.

`DisconnectReason.connectionReplaced` (440) is deliberately left on the
recoverable side: another client taking the session over is real, but the
ladder is bounded at five attempts, so the two ends stop fighting inside ~75
seconds rather than forever. Making it terminal would also make a routine
network blip that WhatsApp happens to report as 440 need a manual restart.

**Every socket carries a generation number.** A `connection.update` from a
socket that is no longer the current one is dropped — that is what stops a late
close from scheduling a reconnect on top of a live connection, or a stale QR
from overwriting a fresh one.

**Terminal closes** (`classifyDisconnect()` in `src/core/connection.js`):

| code | verdict |
| --- | --- |
| `DisconnectReason.loggedOut` (401) | terminal. Clears the credentials, state `logged_out`. |
| `405` (`CONNECTION_FAILURE_405`) | terminal. **Credentials untouched** — 405 means WhatsApp refused the connection, not that the pairing is gone. |
| `DisconnectReason.forbidden` (403) | terminal. Credentials untouched. |
| `DisconnectReason.restartRequired` (515) | recoverable, and never counts as a failed pairing — it *is* the login handshake. |
| anything else | recoverable: the 5/10/15/20/25 schedule. |

405 is not in Baileys' enum; WhatsApp sends `<failure reason="405">` and Baileys
passes the integer straight through. It is named in `connection.js` rather than
left as a bare literal.

**A pairing attempt that closes before anyone scans is not retried.** The stale
QR is deleted and the session goes back to a startable state. Regenerating one
forever is what the old code did to installs nobody was pairing.

**Retry exhaustion never exits the process.** `src/core/session.js` contains no
`process.exit`; a WhatsApp connection that will not come back is not a reason to
take the control panel down with it.

### Message Flow

1. **Incoming Message** → `src/core/events.js:44` (messages.upsert event)
2. **Message Handler** → `src/handlers/message.handler.js:14` (handleIncomingMessage)
3. **Middleware Chain**:
   - Forward tracking → `src/middleware/forward-tracking.middleware.js`
   - Check blacklist → `src/middleware/blacklist.middleware.js`
   - Anti-spam → `src/middleware/antispam.middleware.js`
4. **Command Detection** → `src/handlers/command.handler.js:44` (handleCommand)
   - Parse prefix (default: `!`)
   - Match command name or alias
   - Execute command with context
5. **Group Moderation** (if in group):
   - Anti-link → `src/commands/group/antilink.js`
   - Media control → `src/commands/group/media.js`

### Command System

Commands are loaded dynamically from `src/commands/`:
- Each command exports: `{ name, aliases, description, chat, execute }`
- Commands are registered in a Map with aliases
- Loaded on startup via `src/handlers/command.handler.js:16`

**Command Structure Example**:
```javascript
module.exports = {
  name: "ping",
  aliases: ["p"],
  description: "Check bot latency",
  chat: "all", // "all", "group", "private"
  async execute(sock, msg, args, body, groupMetadata) {
    // Command logic here
  }
};
```

### Baileys v7 (IMPORTANT)

This project uses **Baileys v7.0.0-rc.6** which has breaking changes from v6:

1. **LID System**: WhatsApp now uses LIDs (Local Identifiers) for privacy
   - Database: `lid_mapping` table stores LID ↔ Phone Number mappings
   - Event: `lid-mapping.update` in `src/core/events.js:22`
   - Utilities: `src/utils/normalizeJid.esm.js` handles both formats

2. **ESM-only exports**: Use `import { makeWASocket }` not `default`

3. **getMessage required**: Baileys config must include `getMessage` function (see `src/config/baileys.config.js:94`)

4. **JID Formats**:
   - Phone Number: `201234567890@s.whatsapp.net`
   - LID: `lid-abc123...@s.whatsapp.net`
   - Group: `120363...@g.us`
   - Always use `normalizeJid()` for safe handling

## Database (SQLite)

One file, `levix.db`, in the data directory. Opened synchronously by
`src/db/db.cjs` the moment it is required — there is nothing to connect to and
nothing that can be unreachable, which is why `src/index.js` has no database
pre-flight any more.

**Why `node:sqlite`**: it ships inside Node, so the datastore adds no
dependency, nothing compiles, and nobody has to install a server before the bot
will start. It is also synchronous, which is what the ~40 storage call sites
already assume — several of them run on the per-message hot path (the anti-spam
and blacklist middleware, the prefix lookup, every permission check) with no
`await` in sight.

**Tables**:

| table | what it holds | expiry |
| --- | --- | --- |
| `bot_settings` | prefix, dashboard settings (`setting:*`), command permission / alias / disabled overrides, the generated session key, the password hash | — |
| `group_settings` | per-group config (welcome, rules, warn limits) | — |
| `warnings` | user warnings per group | — |
| `todos` | `!todo` lists | — |
| `notes` | group notes / saved messages | — |
| `ai_history` | Gemini conversation history per chat | — (wipe with `!del` / `!delall`) |
| `baileys_auth` | WhatsApp creds and session keys | — |
| `qr_codes` | the pairing QR for the dashboard | — |
| `lid_mapping` | LID ↔ phone number mappings (v7) | — |
| `user_metadata` | per-user record; `is_owner` / `is_admin` carry the bot roles | — |
| `debts` | `!debt` ledger | — |
| `schedules` | `!schedule` / `!autoschedule` jobs | — |
| `forward_scores` | forward counters per message | `forward_score_ttl_days` (30) |

`forward_scores` gains a row per forwarded message, so it expires; the sweep
runs at boot and every six hours (`sweepExpired()` in `db.cjs`).

The bot does **not** archive other people's messages. Nothing incoming is
written beyond the forward counter and the sender's last-seen row; deleted and
edited messages are not captured at all.

Long-term AI memory is **not** in the database — it lives in `memory/*.md`
inside the data directory.

### Schema and migrations

`src/db/db.cjs` holds an array of migration functions and stamps
`PRAGMA user_version`. Every start applies what is missing, so upgrading is
just new code. **Append a migration; never edit one that has shipped.**

### Access

- CommonJS: `src/utils/storage.cjs`
- ESM: `src/utils/storage.esm.js`
- AI history (async signatures, sync underneath): `src/utils/storage-hub.*`
- Lifecycle: `initStore()` / `flushStore()` from `src/db/store.esm.js`

Both storage modules are thin re-exports of `src/db/store.cjs`, which holds
every query. Reads and writes are synchronous and land on disk immediately —
there is no cache and no write-behind queue to reason about.

### The data directory

`src/config/paths.cjs` resolves the one directory the bot writes to: database,
`memory/`, the editable `ai-persona.md`, `logs/`, temp `media/`. Order:
`--data <dir>`, then `LEVIX_DATA_DIR` (the only environment variable the code
reads — Docker has no other way to point at its volume), then `<repo>/data`
when running from a clone, then `~/.levix`.

`assetPath()` is the read-only counterpart: `views/`, `public/`, the persona
template. A packaged build unpacks those and calls `setAssetRoot()`.

## Key Features Implementation

### 1. AI agent — Gemini (`src/commands/gemini.cjs`)

The AI is an **agent**, not a single API call: it can call tools over several
rounds before answering, and the whole run is narrated in ONE WhatsApp message
that gets edited (`🤖 بفكر...` → `🔍 ببحث عن ...` → the answer).

**Layout**
- `src/commands/gemini.cjs` — WhatsApp surface: builds Gemini `parts` from the
  message (text / image / video / audio / document / quoted), the multi-message
  context buffer, `!generate`, and the Groq + expired-file fallbacks.
- `src/services/aiAgent.cjs` — the loop: system instruction, tool rounds,
  history trimming.
- `src/services/aiTools.cjs` — the tools themselves.
- `src/config/ai-persona.md` — **the operator's behaviour prompt**, in English.
  Hot-reloaded (everything above the first `---` is a note to the human and is
  stripped), and editable from the dashboard. It holds behaviour and personality
  only: no product metadata, and no explanation of what else is in the prompt.
- `src/config/ai-identity.cjs` — the part that is NOT editable: the product
  identity block (what Levix is, who built it, and how to talk about that) is
  prepended above the persona on every request, so a rewritten persona or a
  crafted message can't change it. It is imported by the agent and by nothing
  else — deliberately not on `brand.cjs`, which every EJS template can render.

The final system instruction is, in order:

```
ai-identity.cjs systemBlock   (code)
<data>/ai-persona.md          (the operator's, below the ---)
runtime context               (who / where / when, code)
memory/*.md                   (long-term memory, capped)
```

**Tools the agent can call**
| tool | what it does |
| --- | --- |
| `web_search` | DuckDuckGo, or Google Programmable Search when `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` are set |
| `fetch_url` | opens a page and reads its text — the host is resolved and every redirect hop re-checked against private/loopback/link-local ranges |
| `save_memory` | writes a fact to `memory/global.md` or `memory/chats/<chat>.md` — global scope is gated on the **caller** being admin/owner |
| `search_memory` / `forget_memory` | read / delete memory entries — deletes are gated on the **caller**, same rule as `!memory forget` |
| `grant_role` / `revoke_role` / `list_roles` | bot owner / admin roles — gated on the **caller**, owner only |
| `get_datetime` | current time in `BOT_TIMEZONE` |

Tools never throw: a failure comes back as `{ error }` so the model can explain
it. Bounded by `AI_MAX_TOOL_STEPS` rounds and `AI_TOOL_TIMEOUT_MS` per call.

Anything privileged is checked **in the tool, against the real sender** — never
in the prompt. The agent reads web pages and other people's messages, so any of
them can ask it to write to the shared memory or hand out a role; the tool is
what says no.

**Sub-commands**
- `!gemini <text>` / `!ask` / `!ai` — ask the agent
- `!gemini add ...` → `!gemini send` — batch several messages into one request
  (`show` / `clear` inspect and drop the buffer)
- `!generate <prompt>` — image generation
- `!del` / `!resetai` — clear the *conversation history* (owner only)
- `!delall` — clear every conversation history (owner only)

Conversation history (short-term) lives in `ai_history`; long-term memory is the
Markdown files below. `!del` does not touch memory.

### 1b. Long-term memory (`src/utils/memory.cjs`, `!memory`)

"احفظ ده في ذاكرتك" writes a Markdown file, the same idea as an agent's
`CLAUDE.md`:

```
memory/
  global.md                 # shared by every chat
  chats/<chat-jid>.md       # one conversation only
```

Every line starting with `-` is one entry; metadata rides in a trailing HTML
comment, so the files stay hand-editable — prose you add yourself is preserved
when the bot adds or removes entries. Both files are injected into the system
prompt on every request (capped by `MEMORY_CONTEXT_CHARS`).

Manual door: `!memory` (list) · `!memory add <fact>` · `!memory add global <fact>`
· `!memory search <word>` · `!memory forget <n>` · `!memory clear [global]` ·
`!memory file [global]` (exports the `.md`). Anyone can add to the chat they are
in; global writes, deletes and exports need admin/owner.

### 1c. Bot roles (`!perm`)

Two bot-level roles, stored in `user_metadata` (`is_owner`, `is_admin`) and
mirrored in an in-memory roster so a grant works on the very next message:

- **owner** — everything, including `OWNER_ONLY` commands.
- **admin** — satisfies `ADMINS_ONLY` / `ADMINS_OWNER` in *any* chat (even DMs,
  where there is no group roster), never `OWNER_ONLY`.

Granted three ways: the panel's Roles screen, the `!perm` command
(`!perm add admin @user`, `!perm add owner <number>`, `!perm remove ...`,
`!perm list`), or by asking the AI ("خلي فلان أدمن") — owner only in every case
for the owner role. The account that scanned the QR is an owner from the start.
`src/utils/permissions.esm.js` is the single source of truth.

### 2. Message Scheduling (`scheduler.cjs`)

**Types**:
- **Once**: One-time scheduled message (specific date/time)
- **Recurring**: Cron-based repeating messages

**Commands**:
- `!schedule` - Create new schedule
- `!listschedules` - View all schedules
- `!deleteschedule <id>` - Delete schedule

**Storage**: the `schedules` table (it used to be `config/schedule.json`, which
the panel couldn't see and a crash mid-write could truncate). Jobs are
`{ id, type, targetJid, message, cronString?, date?, status, creatorJid }`.

**Initialization**: called on every successful connection — `scheduleNewJob()`
stops the previous timer for the same id first, or a weekly message would be
sent twice after the first reconnect.

### 3. Group Moderation

**Features**:
- Welcome messages (`src/commands/group/welcome.js`)
- Anti-link protection (`src/commands/group/antilink.js`)
- Media restrictions (`src/commands/group/media.js`)
- Anti-spam (`src/middleware/antispam.middleware.js`)
- Warning system (`src/commands/group/warn.js`)
- Auto-kick after N warnings (configurable per group)

**Admin Commands**: kick, promote, demote, add, removeall, setname, setpp, etc.

### 4. (removed) REST API

`POST /api/send` and its API key are gone, along with
`src/routes/sendMessage.esm.js` and `src/middleware/auth.esm.js`. The control
panel is the only HTTP surface. Don't add an unauthenticated-by-default write
endpoint back without a reason that survives "this holds a whole WhatsApp
account".

### 5. Utility Commands

- **`!calc <معادلة>`** (`src/commands/calc.cjs`) — hand-written tokenizer +
  recursive-descent parser (never `eval`). Handles `+ - * / % ^ !`, parentheses,
  implicit multiplication, percentages (`15%`, `20% من 300`), Arabic-Indic
  digits, and a whitelist of math functions.
- **`!loop <عدد|من-إلى[:خطوة]> [نص]`** (`src/commands/loop.cjs`) — repeats text or
  prints a number range; `-s` sends separate messages, `-n` drops the numbering,
  `{n}`/`{i}` are substituted per line. Capped at 100 iterations (15 when split).
- **`!poll <سؤال> | <خيار> | <خيار>`** (`src/commands/poll.cjs`) — native WhatsApp
  poll; `--multi` allows several answers.
- **`!rand`** (`src/commands/rand.cjs`) — random numbers, `dice 2d6`, `coin`,
  `pick a | b | c`.
- **`!memory`** (`src/commands/memory.cjs`) — the Markdown long-term memory.
- **`!perm`** (`src/commands/perm.cjs`) — bot owner / admin roles.

### 5b. Domain setup (`levix domain`, `src/domain/`)

Points a domain at Levix **by working with whatever the server already runs.**
The rule the whole module serves: *Levix integrates with the server it finds;
it does not take over the server.* A VPS may be running somebody's shop.

- `system.js` — the only place that touches the machine (`run`, `exists`,
  `writeFile`, `listeners`, DNS). Injectable, which is how the tests describe a
  server without one existing.
- `detect.js` — `inspect()` changes nothing; `classify()` turns the report into
  one of: `nginx`, `caddy`, `apache`, `panel`, `docker`, `blocked`,
  `install-caddy`.
- `nginx.js` / `caddy.js` — render one Levix-specific site, validate the whole
  configuration (`nginx -t`, `caddy validate`), and reload **only** if it
  passed. A failure restores exactly what was there and prints the web
  server's own error. Never a restart, never a second server block.
- `command.js` — the flow, the prompts and what gets persisted.

A detected hosting panel (Plesk, cPanel, CloudPanel, CyberPanel, aaPanel,
HestiaCP, ISPConfig, Coolify, Dokploy…), Apache, a container, or an
unrecognised process on :80/:443 all mean **print instructions, change
nothing**.

On success it saves `public_domain`, sets `trust_proxy=1` (exactly one hop —
the proxy it just configured) and `bind_address=127.0.0.1`, so the panel can no
longer be reached past the certificate on its raw port.

### 5c. Opening a browser (`src/utils/openBrowser.cjs`)

`levix` opens the panel only on something that looks like a desktop. Several
signals have to agree — SSH, systemd, containers, CI and a missing display all
veto it — and the decision is a pure function so it can be tested against a
synthetic environment. Failing to open a browser is never fatal; the URL is
printed either way. `LEVIX_OPEN_BROWSER=1/0` overrides in both directions.

### 6. One message per command (`src/utils/statusMessage.cjs`)

Commands must not narrate their work with a stream of messages
("searching…", "processing…", "downloading…"). Post one line and rewrite it:

```javascript
const { createStatus } = require("../utils/statusMessage.cjs");

const status = await createStatus(sock, jid, "🔍 بحلل الرابط...", { replyTo: msg });
await status.update("🎬 بنزّل الفيديو...");   // edits the same message
await status.finish("✅ اتبعت (12.3 MB)");    // last edit
await status.fail(error, "حصلت مشكلة");       // error card, same message
await status.remove();                        // delete it (when media IS the answer)
```

Everything is best-effort: if the edit is rejected (message too old, not ours)
it falls back to a normal send.

Already wired: `!gemini`, `!weather`, `!shortlink`, `!stt`, `!tts`.

### 7. Text decoding (`src/utils/textDecode.cjs`)

Everything that comes off the network goes through here:

- `decodeBuffer(buffer, contentType)` — decodes with the charset the server
  actually declared (header or `<meta charset>`); windows-1256 / iso-8859-6 are
  common on Arabic pages and were previously read as UTF-8.
- `decodeText(str)` — `\uXXXX` escapes (surrogate pairs intact), HTML entities
  (`&#1575;`, `&quot;`), and latin1 mojibake repair, scored so correct Latin
  text ("Café") is never "fixed" into garbage.
- `stripHtml(html)` — page text for the AI agent.

The AI agent's `fetch_url` tool runs every page it opens through these.

## Dashboard (`views/` + `public/` + `src/routes/dashboard.api.esm.js`)

A password-gated control panel at `/`. It is not a viewer — almost everything
the bot does can be changed from it, live:

| Screen | What it changes | Where it lands |
| --- | --- | --- |
| Overview | — (counters, uptime, connection) | — |
| Connection | **start / stop** the session, QR pairing, **unlink**, restart | `src/core/session.js` |
| Commands | prefix · aliases · permission · on/off | `bot_settings` via `runtime-config.cjs` |
| AI & memory | the system prompt · the `memory/*.md` files | `<data>/ai-persona.md`, `<data>/memory/` |
| Groups | antilink · antispam · media · welcome · warnings · rules | `group_settings` |
| Roles | bot owner / admin | `user_metadata` (same path as `!perm`) |
| Tables | debts · warnings · notes · todos · users · schedules | read-only (schedules can be deleted) |
| Settings | API keys, model, timezone, delays, thumbnails, port, proxy | `bot_settings` (`setting:*`) |
| Settings → password | the panel's own password | `bot_settings` (scrypt hash) |

Front end is `views/dashboard.ejs` + `public/dashboard.css` + `public/dashboard.js`:
plus `views/setup.ejs` for the first run. Plain browser JS, no framework,
**no CDN** — the QR library and the socket.io client are both served from
`public/`. Everything rendered came out of a WhatsApp message, so it goes
through `esc()` before it touches `innerHTML`.

**First run.** With no password set, `/` redirects to `/setup`. From localhost
that page just asks for a password; from anywhere else it also asks for the
setup code printed in the terminal at startup, so a bot that comes up on a
public IP can't be claimed by whoever finds the port first. See "Configuration"
for how a value resolves.

**What the dashboard deliberately can't do:** change the bot's name or its
author (`brand.cjs`), or lower the permission of a command that declares
`userAdminRequired` — those call WhatsApp admin actions and would refuse the
caller anyway, so the UI marks them locked instead of lying.

## Configuration

**There is no `.env` file and no config file.** Everything an operator can
change is a row in the database, edited from the control panel.

A setting resolves in two steps, and both the panel and the WhatsApp commands
go through the same accessors:

1. what the operator saved (`setting:*` in `bot_settings`)
2. the default baked into `src/config/settings.cjs`

Which means a fresh install runs correctly against an empty database, and
`git pull` never conflicts with someone's local edits.

- `src/config/settings.cjs` — timezone, reply delays, AI keys and model, tool
  limits, memory size, thumbnails, ffmpeg path, port, proxy hops, extra origin,
  forward-score retention. **Consumers must call `settings.get(key)` at call
  time**, never once at import, or a change wouldn't apply until a restart.
  Settings that genuinely can't apply live are marked `restart: true` and the
  panel says so next to the field.
- `src/config/runtime-config.cjs` — prefix, command permissions, alias
  overrides, disabled commands. Group sub-commands are keyed `group:<name>`.
- Secrets are **generated, never configured** (`src/config/secrets.cjs`): the
  session signing key on first start, the password as an scrypt hash chosen in
  the browser. Third-party API keys are stored like any setting, but the API
  only ever reports whether one is configured — the value never leaves the
  server.

The one environment variable read anywhere in the code is `LEVIX_DATA_DIR`,
because a Docker volume has no other way to say where it is. `--data <dir>`
does the same thing on the command line.

### Who is the owner

Whoever scans the QR. `handleConnectionOpen()` in `src/core/connection.js`
records the paired account as an owner and seeds the in-memory rosters from
`user_metadata`; everyone else is
granted from the panel (Roles) or with `!perm`. There is no owner list to
configure.

## Creating New Commands

1. Create file in `src/commands/` (use CommonJS)
2. Export object with structure:
   ```javascript
   module.exports = {
     name: "commandname",
     aliases: ["alias1", "alias2"],
     description: "What the command does",
     chat: "all", // "all", "group", or "private"
     async execute(sock, msg, args, body, groupMetadata) {
       // Implementation
       await sock.sendMessage(msg.key.remoteJid, { text: "Response" });
     }
   };
   ```
3. Restart bot (commands loaded on startup)

**Common Patterns**:
- Get sender: `msg.key.participant || msg.key.remoteJid`
- Check if group: `msg.key.remoteJid.endsWith('@g.us')`
- Parse args: `const arg1 = args[0]` (args array from `body.split(/ +/)`)
- Reply: `await sock.sendMessage(chatId, { text: "..." })`
- Quote reply: Add `quoted: msg` to message object

## Logging

**Logger**: Pino logger in `src/utils/logger.js`
```javascript
import logger from './utils/logger.js';
logger.info('Message');
logger.error({ err: error }, 'Error message');
logger.debug('Debug info');
```

**Log Levels**: silent → fatal → error → warn → info → debug → trace

**Configuration**: Set via Baileys config or logger initialization

## Common Gotchas

1. **Module System Mixing**: Always check if file is ESM or CommonJS before importing
2. **JID Normalization**: Use `normalizeJid()` for all JID operations (v7 compatibility)
3. **Group Metadata Cache**: Cached in `src/core/socket.js:7`, automatically updated
4. **Async Command Execution**: All command `execute` functions should be `async`
5. **Message Types**: Handle `conversation`, `extendedTextMessage`, `imageMessage`, etc.
6. **Connection Retry**: owned by `src/core/session.js`, staged linear backoff
   (5/10/15/20/25s), never exponential, never a `process.exit`. Nothing else may
   create a Baileys socket — go through the session manager.
7. **Database Operations**: everything through `storage.cjs` /
   `storage.esm.js` is synchronous and lands on disk immediately — SQLite is a
   function call, not a round trip. There is no cache to invalidate and no
   queue to drain. New queries belong in `src/db/store.cjs`; a new column or
   table belongs in a new migration in `src/db/db.cjs` (append, never edit a
   shipped one).
8. **Media Thumbnails**: Baileys can't build them here (no `sharp`/`jimp`, and its
   video path needs `ffmpeg` on the PATH — ours lives in `ffmpeg-static`).
   `src/utils/thumbnail.cjs` generates `jpegThumbnail` + width/height/seconds with
   ffmpeg-static and `src/core/socket.js` patches `sock.sendMessage` so every send
   path gets one. Pass your own `jpegThumbnail` to opt out.
9. **Command `usage`**: Written WITHOUT the prefix (`"kick @عضو [السبب]"`), one
   variant per line. `!help` prepends the live prefix and prints them as the
   command's parameters.
10. **Never post progress messages**: use `createStatus()` and edit one message
    (see "One message per command"). A command that sends "جاري..." and then a
    result is a bug.
11. **Decode anything scraped**: run titles/captions through `decodeText()` and
    page bodies through `decodeBuffer()`; raw scraper output is full of HTML
    entities, `\uXXXX` escapes and mojibake.
12. **`saveUserMetadata` only writes role flags when you pass them**: calling it
    with `isOwner: false` used to demote real owners on their next message.
    Pass `isOwner` / `isAdmin` only when you mean to change them.
13. **Don't reintroduce message archiving**: the bot deliberately keeps no copy
    of other people's messages, and has no anti-delete / anti-edit handler. The
    only in-memory message store is `recentMessageCache.esm.js`, which holds
    messages the bot ITSELF sent so Baileys' `getMessage` can answer a retry.
14. **Don't add third-party media downloaders**: downloading from YouTube /
    TikTok / Facebook / Instagram violates those platforms' terms, so those
    commands were removed on purpose.
15. **Read runtime settings at call time**: `settings.get(...)` and
    `runtimeConfig.get*(...)` must be called inside the function that uses the
    value. Hoisting one into a module-level `const` re-introduces
    "restart before it applies", which is exactly what the dashboard exists to
    avoid.
16. **The bot's name and author are frozen.** `src/config/brand.cjs` is the
    public half (the UI renders it); `src/config/ai-identity.cjs` is the half
    the model gets, and it must stay first in the system instruction. Never add
    an API field, a setting or a config key for either, never import
    `ai-identity.cjs` from a route or a view, and never put those facts into
    `ai-persona.md` — that file belongs to the operator.
17. **`bot_settings.value` is Mixed**: it holds strings, numbers, booleans AND
    objects (the permission / alias override maps). Don't narrow that schema.
18. **New command? Nothing else to do.** Permissions default from
    `src/config/defaults.cjs`, and the dashboard picks the command up from the
    loader's catalog (`getCommandCatalog()`), so it shows up on its own.
19. **Nothing writes next to the code.** Anything created at runtime goes
    through `dataPath()` / `ensureDataDir()` (`src/config/paths.cjs`); anything
    that ships and is only read goes through `assetPath()`. A global install
    and a packaged binary both depend on that split.
20. **Don't add an environment variable.** `LEVIX_DATA_DIR` is the only one,
    and it exists because a Docker volume can't be expressed any other way.
    Everything else is a setting in `settings.cjs`, so the panel can change it.
21. **Headless must stay headless.** Never require `app.cjs` (or anything that
    requires it) from `src/bootstrap/core.js`, `src/cli.js` or `src/index.js`'s
    headless path — requiring it *is* constructing the panel. `tests/headless.test.mjs`
    checks the loaded-module list, not just the port.
22. **Never decide "is this local" from `req.ip`.** Express derives it from
    `X-Forwarded-For` as soon as `trust proxy` is set, so a remote client picks
    its own value. Use `src/utils/requestOrigin.cjs`; see the note at the top
    of that file for the takeover it prevents.
23. **`levix domain` may run as root on somebody's production server.** Inspect,
    generate a Levix-only file, validate, and only then reload. If validation
    fails, restore and print the server's own error. Unrelated sites are never
    touched.
24. **`deploy/install.sh` is the only installer.** The files served from
    `levix.leviro.net/install.sh` and `/install/vX.Y.Z.sh` are generated from
    it during a release (`scripts/build-release-installer.mjs` rewrites the one
    `VERSION=` line) and published by `scripts/publish-installer.sh`. Never
    commit a generated copy, never add a second installer, and keep that
    `VERSION="latest"` line exactly one assignment on one line — the generator
    and `tests/installer.test.mjs` both require it.
25. **Keep the loaders manifest-friendly.** `command.handler.js` and
    `group.cjs` read a directory, and fall back to a generated `_manifest.cjs`
    when there isn't one (that's how the single-executable build works). If you
    add another directory scan at load time, give it the same fallback.

## Testing Workflow

1. Start the bot: `npm start` (nothing to set up first; `data/` is created)
2. Open `http://localhost:3001/`, pick a password on the setup page
3. Go to Connection, press **Start session**, scan the QR
4. Send `!ping` in WhatsApp
5. Check the logs, and the database if the change touches it
6. To start from scratch: stop the bot and delete `data/`

## Code Style Notes

- **Language**: Code comments mix Arabic and English (commands in Arabic)
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Error Handling**: Always log errors with context using Pino
- **Message Sending**: Use `sock.sendMessage()`, not deprecated methods
- **Async/Await**: Prefer over callbacks or raw promises

## Important Files Reference

- **CLI**: `src/cli.js` (`bin/levix.js` is a wrapper)
- **Startup**: `src/bootstrap/core.js` · `src/bootstrap/panel.js` · `src/bootstrap/events.cjs`
- **WhatsApp session lifecycle**: `src/core/session.js`
- **Domain setup**: `src/domain/`
- **Local-request check**: `src/utils/requestOrigin.cjs`
- **Single-instance lock**: `src/config/lock.cjs`
- **Tests**: `tests/` (`npm test`), `scripts/validate-*.{mjs,sh}`
- **Entry Point**: `src/index.js` (ESM, loads everything)
- **Web Server**: `app.cjs` (CommonJS, exports the Express app)
- **Command Loader**: `src/handlers/command.handler.js`
- **Shipped defaults**: `src/config/defaults.cjs` (prefix + permissions),
  overridden at runtime by `src/config/runtime-config.cjs`
- **Brand (frozen, public)**: `src/config/brand.cjs`
- **AI product identity (code-owned, model-only)**: `src/config/ai-identity.cjs`
- **Runtime settings**: `src/config/settings.cjs`
- **Generated secrets**: `src/config/secrets.cjs`
- **Data directory**: `src/config/paths.cjs`
- **Dashboard API**: `src/routes/dashboard.api.esm.js`
- **Database**: `src/db/db.cjs` (file, schema, migrations)
- **Queries**: `src/db/store.cjs`
- **Socket Creation**: `src/core/socket.js`
- **Event Setup**: `src/core/events.js`

## Additional Documentation

- `README.md` - what the bot is
- `SETUP.md` - the non-developer setup guide
- `PACKAGING.md` - shipping it: npm, Docker, systemd, single executable
- `src/config/ai-persona.md` - the operator's behaviour prompt template
  (English). The live copy is `<data>/ai-persona.md`, hot-reloaded and editable
  from the panel. Everything above the `---` is a note to the human and is not
  sent to the model
- No need to test at all, Don't run npm start for the testing messages, i'll do it by myself in next times