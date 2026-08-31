# Security Policy

## Supported versions

Security fixes are applied to the latest stable Levix release. Upgrade to the
latest release before reporting an issue that may already be fixed.

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected vulnerability.

Use
[GitHub private vulnerability reporting](https://github.com/Abdodiab2005/levix/security/advisories/new)
and include:

- The affected Levix version and installation method.
- The operating system and deployment shape.
- Clear reproduction steps or a proof of concept.
- The security impact and the boundary you expected.
- Relevant logs with passwords, setup codes, API keys, WhatsApp credentials,
  phone numbers, and personal data removed.

Please allow time to reproduce and fix the issue before public disclosure. A
report may be closed as not applicable when it only describes the known risks of
using an unofficial WhatsApp client.

## Sensitive data

Never attach a Levix data directory, SQLite database, WhatsApp session, setup
code, panel cookie, API key, private memory file, or unredacted log to a public
issue.

## WhatsApp protocol risk

Levix uses Baileys, an unofficial WhatsApp Web client. Protocol changes, account
restrictions, and bans are controlled by WhatsApp and are not Levix security
vulnerabilities. Do not use Levix for spam or unsolicited bulk messaging. Use
the official WhatsApp Business Platform when an outage or account restriction
is unacceptable.
