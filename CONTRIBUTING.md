# Contributing to Levix

Thanks for helping improve Levix. Bug reports, documentation fixes, focused
features, and tests are welcome.

## Before you start

- Search the existing issues and pull requests to avoid duplicate work.
- Open an issue before a large feature, architecture change, or behavior change.
  Small fixes and documentation improvements can go directly to a pull request.
- Report security vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md).

## Local setup

Levix requires Node.js 24 or newer.

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
npm ci
npm test
npm start
```

The default source-checkout data directory is `./data`. Do not commit its
database, WhatsApp credentials, logs, generated secrets, or local configuration.

## Project rules

A change should preserve these invariants:

- Mutable state belongs in the data directory, not beside application code.
- The SQLite database remains the source of truth for runtime settings.
- Fresh panel installs do not start WhatsApp pairing without an explicit action.
- Previously paired sessions resume automatically unless explicitly stopped or
  unlinked.
- Headless mode does not start Express, Socket.IO, or a listening web port.
- User-facing secrets must never be logged, committed, or returned unnecessarily.
- Existing npm, Docker, systemd, and standalone-binary workflows must continue
  to work.

Read [AGENTS.md](AGENTS.md) for the module layout, storage API, message flow, and
additional architectural constraints.

## Making a change

1. Create a focused branch from `main`.
2. Keep the change small enough to review.
3. Add or update tests for changed behavior.
4. Run the full test suite:

   ```bash
   npm test
   ```

5. Update README or SETUP documentation when user-facing behavior changes.
6. Open a pull request explaining the problem, the chosen solution, and how it
   was verified.

Do not include unrelated formatting, generated data, credentials, or dependency
updates in the same pull request.

## Pull request checklist

- The change has one clear purpose.
- Tests pass locally.
- New behavior has regression coverage.
- Documentation matches the final behavior.
- No credentials, phone numbers, session files, or private logs are included.
- Backward compatibility and persisted data were considered.

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](LICENSE).
