# Contributing to Levix

Levix is a self-hosted personal WhatsApp bot with group moderation, scheduled
messages, an AI agent, media tools and a browser-based control panel. Bug
reports, documentation fixes, focused features and tests are welcome.

## Table of Contents

- [Before You Start](#before-you-start)
- [Code Style](#code-style)
- [File Organization](#file-organization)
- [Documentation](#documentation)
- [Testing](#testing)
- [Git Workflow](#git-workflow)
- [Security](#security)
- [Performance](#performance)
- [Getting Started](#getting-started)
- [Tools and Configuration](#tools-and-configuration)
- [Code Review Guidelines](#code-review-guidelines)
- [Questions](#questions)

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Open an issue before a large feature, architecture change or behavior change.
- Small fixes and documentation improvements can go directly to a pull request.
- Report suspected vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md).

Read [AGENTS.md](AGENTS.md) for the module layout, storage API, message flow
and additional project constraints.

## Code Style

### General Principles

1. **Readability first**: Keep command, panel and service behavior easy to
   follow.
2. **Consistency**: Extend the existing module and storage patterns before
   introducing a new abstraction.
3. **Small changes**: Keep a pull request focused on one coherent purpose.
4. **Runtime correctness**: Preserve live settings, persisted state and the
   session lifecycle when changing shared code.

### Module Systems

Levix uses both ES modules and CommonJS:

- Use ES module `import` and `export` syntax in `src/index.js`, `src/core/`,
  `src/handlers/`, `src/middleware/`, `src/routes/` and ESM utilities.
- Use CommonJS in `app.cjs`, `scheduler.cjs`, `src/commands/`, most
  `src/utils/` and `src/db/store.cjs`.
- When an ES module imports CommonJS, use the existing `createRequire` pattern.
- Do not mix module systems without an explicit bridge.

### Naming and Implementation

- Use camelCase for variables and functions.
- Use PascalCase for classes.
- Use descriptive names; do not use one-letter variables.
- Keep comments short and explain why a non-obvious decision exists.
- Prefer async/await in asynchronous code.
- Use `sock.sendMessage()` for WhatsApp messages.
- Use `normalizeJid()` for JID handling where the Baileys v7 LID format matters.

Runtime settings must be read with `settings.get(key)` or the corresponding
runtime configuration accessor at call time. Do not cache a mutable dashboard
setting at module load.

## File Organization

### Directory Structure

```text
bin/                 # The levix command wrapper
src/commands/        # CommonJS WhatsApp command handlers
src/config/          # Paths, settings, defaults, identity and Baileys config
src/core/            # WhatsApp socket, events, session, connection and proxy
src/db/              # SQLite schema, migrations and queries
src/domain/          # Domain and reverse-proxy setup
src/handlers/        # Message, command and group event handling
src/middleware/      # Message filtering and permissions
src/routes/          # Dashboard API routes
src/services/        # AI providers, agent tools and related services
src/utils/           # Storage, memory, logging, decoding and shared utilities
tests/               # Node-based regression tests
views/               # EJS panel views
public/              # Dashboard assets and browser-side JavaScript
```

### Ownership Rules

- Runtime files belong in the data directory resolved by `src/config/paths.cjs`.
- The database is the source of truth for runtime settings.
- Add SQLite schema changes as a new migration in `src/db/db.cjs`; do not edit
  a migration that has already shipped.
- The session manager in `src/core/session.js` is the only code allowed to
  create or destroy a Baileys socket.
- Keep `src/config/brand.cjs` and `src/config/ai-identity.cjs` code-owned. The
  bot name and author are not operator settings.

## Documentation

Update [README.md](README.md) or [SETUP.md](SETUP.md) when user-facing
behavior, installation, configuration or deployment changes.

Document commands using the existing command structure. A command belongs in
`src/commands/`, uses CommonJS and exports `name`, `aliases`, `description`,
`chat` and an asynchronous `execute` function.

Do not document secrets, WhatsApp credentials, private memory files or local
database contents with real values. Keep examples reproducible and remove
personal data from logs and screenshots.

## Testing

### Test Structure

Tests run from `tests/run.mjs` and cover connection handling, session lifecycle,
storage, migrations, providers, proxy behavior, the panel, packaging and
installation.

Run the complete suite with:

```bash
npm test
```

Add or update regression coverage for changed behavior. Changes to persisted
state should consider fresh databases and existing databases with migrations.

### Distribution Checks

Changes affecting a packaged or deployed installation should also use the
relevant repository checks:

```bash
npm run validate:tarball
npm run validate:sea
npm run validate:docker
```

Do not use `npm start` as a test harness. The bot's panel and WhatsApp session
are intended to be started manually when an interactive check is needed.

## Git Workflow

### Branches and Changes

1. Create a focused branch from `main`.
2. Keep the change small enough to review.
3. Add or update tests for changed behavior.
4. Update documentation when the user-facing behavior changes.

Do not include unrelated formatting, generated data, credentials, phone
numbers, session files, private logs or dependency updates in the same change.

### Commit Messages

Use an imperative subject that describes one coherent intent. Explain the
reason and relevant tradeoffs in the body when the subject is not enough.

```text
Add regression coverage for session retry exhaustion

Keep the panel running after WhatsApp retries are exhausted.
```

## Security

### Sensitive Data

Never commit or publicly attach a data directory, SQLite database, WhatsApp
session, setup code, panel cookie, API key, private memory file or unredacted
log.

Passwords and third-party API keys must not be logged or returned unnecessarily.
When reporting a problem, remove passwords, setup codes, API keys, WhatsApp
credentials, phone numbers and personal data from logs.

### Authentication and Authorization

Preserve the password-gated control panel and setup boundary. Use the existing
permission checks for owner and admin actions and enforce privileged behavior
in the tool or command that performs it rather than relying on prompt text.

Do not add an unauthenticated write endpoint for the WhatsApp account. Report
suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public
issue.

### WhatsApp Protocol Risk

Levix uses Baileys, an unofficial WhatsApp Web client. Protocol changes,
account restrictions and bans are controlled by WhatsApp and are not Levix
security vulnerabilities. Do not use Levix for spam or unsolicited bulk
messaging.

## Performance

### Database Operations

Levix uses synchronous SQLite through Node's `node:sqlite`. Put new queries in
`src/db/store.cjs` and use the existing storage exports rather than adding a
second database access path.

The database writes synchronously to disk. Avoid unnecessary queries on the
per-message path, preserve existing expiry behavior for forward scores and
keep migrations append-only.

### External Operations

Use the existing bounded behavior for network and AI operations. Preserve
timeouts and tool-step limits, decode network content through
`src/utils/textDecode.cjs` and keep the WhatsApp proxy scoped to WhatsApp
traffic.

Commands should post one status message and edit it as work progresses. Use
`src/utils/statusMessage.cjs` instead of sending a stream of progress messages.

## Getting Started

1. Clone the repository and enter its directory:

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
```

2. Install dependencies and run the tests:

```bash
npm ci
npm test
```

3. Start Levix when an interactive check is needed:

```bash
npm start
```

The project requires Node.js 24 or newer. A source checkout stores runtime
data in `./data` by default. Do not commit that directory.

## Tools and Configuration

### Required Tools

- **Node.js**: 24 or newer
- **npm**: Included with Node.js
- **Git**: Required for a source checkout

### Available Scripts

```bash
npm start              # Start the panel in normal mode
npm run dev            # Start with nodemon
npm test               # Run the test suite
npm run brand:assets   # Build brand assets
npm run build:sea      # Build the standalone executable
```

The validation scripts exercise distribution artifacts:
`validate:tarball`, `validate:sea` and `validate:docker`.

### Runtime Configuration

Levix has no `.env` file or application configuration file. Operator-changeable
values are stored in SQLite and edited from the control panel. The only
environment variable read by the application is `LEVIX_DATA_DIR`; the command
line `--data <dir>` can also select the data directory.

Panel mode starts idle and does not start WhatsApp pairing until requested.
Headless mode can be started with:

```bash
node bin/levix.js headless
```

## Code Review Guidelines

Review changes for:

1. **Functionality**: Does the behavior match the existing command, panel or
   session contract?
2. **Persistence**: Are data-directory, SQLite, migration and compatibility
   concerns handled?
3. **Security**: Could the change expose credentials, weaken authentication
   or bypass an owner/admin check?
4. **Testing**: Is changed behavior covered by a focused regression test?
5. **Operations**: Do panel, headless, Docker, systemd and packaged workflows
   remain valid where applicable?
6. **Documentation**: Do README, setup, security and contributor instructions
   match the resulting behavior?

Pull requests should explain the problem, the chosen solution and how the
change was verified. Address review feedback before merging.

## Questions?

Check the existing source, [README.md](README.md), [SETUP.md](SETUP.md) and
[AGENTS.md](AGENTS.md) for project-specific guidance. For bugs and feature
discussion, use the repository's [GitHub issues](https://github.com/Abdodiab2005/levix/issues).

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](LICENSE).
