<h1 align="center">Levix</h1>

<p align="center">
  <img src="public/brand/banner.webp" alt="Levix - Personal WhatsApp Bot" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Abdodiab2005/levix/actions/workflows/ci.yml"><img src="https://github.com/Abdodiab2005/levix/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/levix-bot"><img src="https://img.shields.io/npm/v/levix-bot?color=2563eb" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24+">
</p>

<p align="center">
  <strong>Free, open-source, self-hosted WhatsApp automation that stays under your control.</strong>
</p>

<p align="center">
  <a href="https://levix.leviro.net">Website</a> ·
  <a href="SETUP.md">Setup guide</a> ·
  <a href="https://github.com/Abdodiab2005/levix/releases/latest">Downloads</a> ·
  <a href="https://github.com/Abdodiab2005/levix/issues">Issues</a>
</p>

Levix is a self-hosted personal WhatsApp bot with 55 commands, group
moderation, scheduled messages, an AI agent, media tools and a web control
panel. It runs on your own computer or server, keeps its database and session
files in your data directory, and lets you change most runtime settings from
the panel.

There is no hosted account, external database, `.env` file or application
configuration file to maintain. Levix is released under the MIT License.

## Disclaimer

Levix uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial
WhatsApp Web client and is not affiliated with or endorsed by WhatsApp or
Meta. Unofficial automation can lead to temporary restrictions or an account
ban.

- Respect WhatsApp's terms, local laws and the privacy of people in your chats.
- Do not use Levix for spam or unsolicited bulk messaging.
- Use a dedicated WhatsApp account where possible.
- If an outage or account restriction is unacceptable, use the official
  WhatsApp Business Platform instead.

## Why Levix?

- A self-hosted WhatsApp bot with a browser-based control panel.
- Runtime settings, command permissions, roles, schedules, memory and logs in
  one local data directory.
- An AI agent with selectable Gemini, OpenAI-compatible and Anthropic providers.
- Durable SQLite storage with no database server to install.
- Panel and headless modes for computers, servers, Docker and packaged builds.

## Features

### Technical features

- **Self-hosted storage**: One SQLite database and one data directory hold
  settings, authentication, schedules, memory, logs, and runtime files.
- **Modular commands**: Command handlers are loaded dynamically from
  `src/commands` and can be configured from the panel.
- **Permission system**: Owner and admin roles, command permissions, aliases,
  and disabled-command overrides are applied by the bot and the dashboard.
- **Live control panel**: Connection state, settings, roles, schedules, memory,
  and logs are available from the browser.
- **Headless operation**: The WhatsApp session can run without a web panel or
  open port.

### Core capabilities

#### Commands and moderation

- Utilities for calculations, notes, todos, polls, random values, prayer times,
  weather, short links, text-to-speech, and speech-to-text
- Group welcome messages, anti-link protection, anti-spam, media restrictions,
  warnings, auto-kick, rules, notes, and participant moderation
- Owner and admin roles, command aliases, per-command permissions, and runtime
  enable/disable controls

#### AI agent

- Gemini, OpenAI-compatible, and Anthropic providers selected from the panel
- Web search, page reading, long-term memory, date and time, and role-management
  tools
- Conversation history in SQLite and long-term memory as editable Markdown
- Optional image generation and media-aware prompts

AI is optional. The rest of Levix works without an AI provider key.

#### Scheduling and storage

- One-time and recurring messages stored as durable jobs
- Delivery status, manual retry, and schedule management from WhatsApp and the
  panel
- One SQLite database for settings, schedules, roles, warnings, notes, todos,
  AI history, WhatsApp authentication, and other bot state
- A single data directory for the database, WhatsApp session, memory, logs, and
  temporary media

#### Control panel

- Pairing, start, stop, reconnect, unlink, connection state, and QR display
- Settings for commands, AI providers, API keys, roles, groups, schedules,
  memory, proxy, server behavior, and logs
- Optional HTTP, HTTPS, or SOCKS5 proxy for WhatsApp traffic only

## Prerequisites

- [Node.js](https://nodejs.org/) 24 or newer
- A phone with WhatsApp and a number with its country code
- [Git](https://git-scm.com/) for a source checkout
- [Docker](https://docs.docker.com/get-docker/) for the container installation

Node 24 includes `node:sqlite`, so Levix does not require a separate database
server or native SQLite installation.

Verify Node.js when installing from npm or source:

```bash
node --version
npm --version
```

## Quick Start

### 1. Install Levix

#### npm

```bash
npm install -g levix-bot
levix
```

#### Linux service installer

The public installer installs the latest stable release and configures Levix as
a service:

```bash
curl -fsSL https://levix.leviro.net/install.sh | bash
```

Read [deploy/install.sh](deploy/install.sh) before running it if you want to
inspect the installation steps.

#### Docker

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
docker compose up -d
```

Standalone Linux, macOS ARM64, and Windows binaries are available from the
[latest GitHub release](https://github.com/Abdodiab2005/levix/releases/latest).

### 2. Open the panel

Open the panel URL printed in the terminal. On a first run, choose a panel
password. Opening setup from another machine also requires the setup code
printed by Levix.

### 3. Pair WhatsApp

Open **Connection**, press **Start session**, and scan the QR code from WhatsApp
under **Settings → Linked devices → Link a device**.

### 4. Test the bot

Send the following command in a WhatsApp chat:

```text
!ping
```

A successfully linked session resumes automatically after a process, Docker, or
systemd restart.

See [SETUP.md](SETUP.md) for headless mode, domain setup, reverse proxies,
backups, keeping Levix running, and troubleshooting.

## CLI

```text
levix                    start Levix with the web panel
levix headless           start Levix with no web UI or open port
levix where              print the data directory
levix reset-password     reset the panel password
levix domain [name]      configure a domain safely (may need sudo)
```

Panel mode waits for you to start the first WhatsApp pairing. Headless mode has
no browser button, so it starts the session itself and prints the QR in the
terminal when needed.

## Configuration

Levix has no `.env` file and does not use an application configuration file.
Operator-changeable values are stored in the SQLite database and edited from
the control panel. Consumers read them at use time, so settings that support
live changes apply to subsequent operations without a restart.

| Area            | Examples                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Commands        | Prefix, aliases, enabled or disabled commands, and permissions                                                                        |
| AI              | `ai_provider`, provider API keys, `gemini_model`, `gemini_stt_model`, `gemini_image_model`, `ai_google_search`, and `openai_base_url` |
| Groups          | Welcome messages, anti-link, anti-spam, media rules, warning limits, and group rules                                                  |
| Scheduling      | One-time and recurring jobs, target chats, messages, and delivery state                                                               |
| Server          | Control-panel port, bind address, public domain, trust proxy, and timezone                                                            |
| Proxy           | HTTP, HTTPS, or SOCKS5 protocol, host, port, username, and password                                                                   |
| Media and tools | Reply delays, thumbnails, ffmpeg path, memory limits, and tool timeouts                                                               |

The only environment variable Levix reads is `LEVIX_DATA_DIR`, which selects the
runtime data directory. Command-line `--data <dir>` takes precedence over it.

Default data locations are:

| Installation               | Location                |
| -------------------------- | ----------------------- |
| npm or global installation | `~/.levix`              |
| Source checkout            | `./data`                |
| Docker                     | The `levix-data` volume |

Copying the data directory backs up the SQLite database, WhatsApp session,
memory, logs, and other runtime files. The panel password is stored as an scrypt
hash, and the session-signing key is generated on first start.

## Project Structure

| Path                             | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| [src/commands](src/commands)     | CommonJS WhatsApp command handlers, including group commands                     |
| [src/core](src/core)             | WhatsApp socket, session lifecycle, connection handling, and proxy support       |
| [src/handlers](src/handlers)     | Message, command, and group event routing                                        |
| [src/middleware](src/middleware) | Message filtering, permissions, anti-spam, blacklist, and forward tracking       |
| [src/routes](src/routes)         | Dashboard API routes                                                             |
| [src/services](src/services)     | AI agent, AI providers, and AI tools                                             |
| [src/db](src/db)                 | SQLite schema, migrations, and storage queries                                   |
| [src/config](src/config)         | Defaults, runtime settings, paths, brand, AI identity, and Baileys configuration |
| [views](views)                   | Login, setup, QR, and dashboard EJS views                                        |
| [public](public)                 | Dashboard JavaScript, CSS, QR library, and brand assets                          |
| [tests](tests)                   | Automated tests and validation harnesses                                         |

Runtime files are created in the data directory, not beside the source files.

## Command Discovery

Commands are loaded dynamically from [src/commands](src/commands). Each command
exports its name, aliases, description, chat scope, and execution handler. Group
subcommands are loaded from the `src/commands/group` directory.

The panel exposes the command catalog and lets an operator change aliases,
permissions, and enabled state. To view available commands in WhatsApp, send:

```text
!help
```

The default command prefix is `!` and can be changed from the panel.

## Command Overview

The command registry loads handlers from [src/commands](src/commands). The
current command families include:

- **General utilities**: `!ping`, `!help`, `!calc`, `!rand`, `!notes`, `!todo`,
  `!poll`, `!weather`, and `!prayer`
- **AI and media**: `!gemini`, `!ask`, `!ai`, `!generate`, `!stt`, and `!tts`
- **Group moderation**: `!group`, `!antilink`, `!blacklist`, `!warn`, `!media`,
  and group administration subcommands
- **Scheduling**: `!schedule`, `!autoschedule`, `!listschedules`, and
  `!deleteschedule`
- **Roles and maintenance**: `!perm`, `!status`, `!restart`, `!shutdown`,
  `!setprefix`, `!block`, and `!unblock`

Use `!help` in WhatsApp for the live command list and usage details. The panel
also exposes the loaded command catalog and its current aliases, permissions,
and enabled state.

## Security and Privacy

- The panel is password-protected. A remote first-time setup also requires the
  setup code printed in the terminal.
- The panel password is stored as an scrypt hash, and API keys are not returned
  by the dashboard settings API.
- The WhatsApp session, database, memory, logs, and temporary media remain in
  the configured local data directory.
- The bot does not archive other people's messages. Incoming messages are not
  permanently stored beyond the state needed for bot features such as forward
  tracking and sender metadata.
- Privileged AI actions validate the real message sender in the tool layer;
  permissions are not granted by prompt text alone.

Do not expose the panel or share setup codes, panel passwords, WhatsApp session
files, or provider API keys. See [SECURITY.md](SECURITY.md) for reporting
security issues.

## Deployment Options

### Linux service

Install the latest stable release and configure it as a service:

```bash
curl -fsSL https://levix.leviro.net/install.sh | bash
```

To pin the current release:

```bash
curl -fsSL https://levix.leviro.net/install/v2.2.1.sh | bash
```

### Docker

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
docker compose up -d
```

The `levix-data` volume keeps the database and WhatsApp session between
container restarts.

### Headless mode

Run Levix without the web interface or an open HTTP port:

```bash
levix headless
```

Headless mode starts the WhatsApp session automatically and prints a QR in the
terminal when pairing is required.

### Domain setup

Configure a domain and reverse proxy with:

```bash
sudo levix domain bot.example.com
```

Levix detects the existing web server or hosting panel, validates generated
configuration before reloading it, and changes only the Levix-specific site.
Apache, hosting panels, containers, and unrecognised listeners receive
instructions instead of being modified.

### Proxy settings

An optional HTTP, HTTPS, or SOCKS5 proxy can be configured under **Settings**.
It applies to WhatsApp traffic, including media, while the control panel and AI
providers continue to use their direct connections. Saving proxy settings does
not interrupt a healthy session; reconnect the session from **Connection** to
apply a pending change.

## Contributing

Before making a substantial change, read [CONTRIBUTING.md](CONTRIBUTING.md).
The usual local workflow is:

```bash
npm ci
npm test
```

When adding a command, create a CommonJS handler in [src/commands](src/commands)
that exports its name, aliases, description, chat scope, and execution handler.
The loader and dashboard catalog discover it automatically.

## Development

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
npm ci
npm test
npm start
```

Useful validation commands:

```bash
npm run validate:tarball
npm run validate:sea
npm run validate:docker
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a substantial change.
For security issues, follow [SECURITY.md](SECURITY.md) and report them
privately.

## Troubleshooting

**The panel does not open**

- Check the panel URL and port printed in the terminal.
- Use `levix where` to confirm the active data directory.
- If the panel password is forgotten, run `levix reset-password`.

**Pairing does not complete**

- Open **Connection** and press **Start session** before scanning the QR.
- Scan the current QR from WhatsApp's linked-device screen.
- For a remote first-time setup, provide the setup code printed in the terminal.

**The bot is not answering**

- Check the connection state in the panel.
- Allow the session to reconnect, or use **Reconnect** from the Connection
  screen.
- If WhatsApp logged out the session, pair it again with a new QR code.

**An AI command fails**

- Select the intended provider in **Settings**.
- Confirm that its API key and model settings are configured.
- Check the panel logs and provider-specific settings.

**The panel password is forgotten**

```bash
levix reset-password
```

This resets the panel password without unlinking the WhatsApp session.

## Support

For bugs, feature requests, and questions, open an issue in the
[Levix repository](https://github.com/Abdodiab2005/levix). Read [SETUP.md](SETUP.md)
for the full installation and deployment guide.

## License

Levix is free and open source under the [MIT License](LICENSE).

Built by [Abdelrhman Diab](https://github.com/Abdodiab2005) under
[Leviro](https://leviro.net).
