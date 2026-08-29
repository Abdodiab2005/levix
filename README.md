# Levix

A self-hosted personal WhatsApp bot: 55 commands, group moderation, an AI agent
on Google Gemini, scheduled messages, and a web control panel that can change
almost all of it while the bot runs.

Built by Abdelrhman Diab (Leviro).

```bash
npm install -g levix-bot
levix
```

The npm package is named `levix-bot`; the installed CLI command stays `levix`.

On a desktop that opens the panel in your browser by itself. Pick a password,
go to **Connection**, press **Start session** and scan the QR — see
[SETUP.md](SETUP.md) for the longer version, Docker, and running it as a
service.

Starting Levix does not connect it to WhatsApp. The panel, the database and the
commands come up on their own, and the WhatsApp session is started from the
Connection screen when you want it.

```
  levix                    start Levix with the web panel
  levix headless           start Levix with no web UI at all
  levix where              print the data directory
  levix reset-password     reset the panel password
  levix domain [name]      point a domain at Levix (may need sudo)
```

---

## What it does

**Commands** — `!ping`, `!help`, `!calc`, `!poll`, `!rand`, `!loop`, `!todo`,
`!notes`, `!debt`, `!weather`, `!prayer`, `!tts`, `!stt`, `!shortlink`,
`!qr`, `!score`… every one of them can be renamed, re-permissioned or turned
off from the panel.

**Group moderation** — welcome messages, anti-link, anti-spam, media rules,
warnings with auto-kick, rules and notes, plus the usual `!group kick`,
`promote`, `demote`, `add`, `tagadmins`.

**An AI agent, not a chat box** — `!gemini` can search the web, open a page and
read it, save something to its long-term memory and hand out bot roles, across
several tool rounds, narrating the whole run inside a single message it keeps
editing. Gemini's own Google Search is available to it too, so questions about
current things get grounded answers with their sources listed. Its personality
is a Markdown file you can edit from the panel.

**Long-term memory** — "remember that…" writes to `memory/global.md` or a
per-chat file. Plain Markdown, hand-editable, injected into every prompt.

**Scheduled messages** — one-off (`!schedule`) or recurring (`!autoschedule`),
stored in the database and listed in the panel.

**Optional proxy** — Settings → WhatsApp proxy routes the WhatsApp connection
through an HTTP, HTTPS or SOCKS5 proxy, including the media it sends and
receives. Nothing else changes: the control panel and the AI still connect
directly.

**A connection you control** — the panel starts, stops and unlinks the
WhatsApp session, and shows what it is actually doing: waiting for a scan,
connected, reconnecting (5s, 10s, 15s, 20s, 25s), or stopped. Reconnects happen
in the bot whether or not a browser is open, and a WhatsApp connection that will
not come back never takes the panel down with it.

**A panel you can also do without** — `levix headless` runs the bot with no
Express, no socket.io and no port open at all; having no screen to press Start
on, it connects by itself and prints its QR straight to the terminal.

**A domain, without a takeover** — `levix domain bot.example.com` looks at what
the server already runs and works with it: it adds one nginx or Caddy site and
validates the whole configuration before reloading, and on a panel-managed or
containerised host it changes nothing and prints the exact reverse-proxy
settings instead.

---

## How it is put together

- **Node 24+**, ES modules and CommonJS side by side (see `CLAUDE.md`).
- **[Baileys v7](https://github.com/WhiskeySockets/Baileys)** for WhatsApp,
  including the LID system.
- **SQLite through `node:sqlite`** — Node's own module, so the whole datastore
  is one file and zero dependencies. No database server, nothing to compile.
- **Express + EJS** for the panel. No framework, no CDN, no build step.
- **Google Gemini** for the AI, with an optional Groq fallback.

Three things follow from that, and they are the point of the design:

**The database is the source of truth, the panel is how you edit it.** There is
no `.env` file and no config file — the prefix, every permission, every API key
and every tuning value is a row in `bot_settings`, and every read goes through
an accessor at call time so a change applies to the next message.

**Secrets are generated, not configured.** The session signing key is made on
first start. The panel password is chosen once, in the browser, and stored as
an scrypt hash.

**Everything mutable lives in one directory** — database, WhatsApp session,
memory files, logs. `levix where` prints it; copying it is a full backup.

---

## For developers

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
npm install
npm start          # data lands in ./data
```

`CLAUDE.md` is the architecture document: module layout, the storage API, the
message flow, and the rules a change has to respect. `PACKAGING.md` covers
shipping it — npm, Docker, systemd, and the single-executable build.

## License

MIT.
