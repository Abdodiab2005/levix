#!/usr/bin/env bash
# Install Levix on a Linux server and run it as a service.
#
#   curl -fsSL https://levix.leviro.net/install.sh | bash
#
# This file is the source of every public installer. The copy served from
# levix.leviro.net/install/vX.Y.Z.sh is this same script with VERSION rewritten
# to that release, which is why a pinned URL keeps installing that version
# forever. The copy in git leaves VERSION as "latest".
#
# What it does, in order — read it before you pipe it into a shell, as you
# should with any script that asks for sudo:
#
#   1. checks for Node 24+ and stops with instructions if it isn't there
#   2. installs the `levix` command globally from the `levix-bot` npm package
#   3. creates a `levix` system user and /var/lib/levix for its data
#   4. installs the systemd unit, pointed at the levix it just installed
#   5. enables it, starts it, and prints where to go next
#   6. offers — but never assumes — to connect a domain
#
# It writes exactly three things outside npm's own prefix: the system user,
# /var/lib/levix, and /etc/systemd/system/levix.service. It never touches an
# existing installation's data, and it can be re-run to upgrade.

set -euo pipefail

PACKAGE="levix-bot"
# Rewritten by scripts/build-release-installer.mjs when a release is published.
# Keep this line exactly as it is: one assignment, one double-quoted value.
VERSION="latest"
SERVICE="levix"
DATA_DIR="/var/lib/levix"
UNIT="/etc/systemd/system/${SERVICE}.service"
MIN_NODE_MAJOR=24
PORT=3001

say() { printf '\n  %s\n' "$*"; }
die() { printf '\n  error: %s\n\n' "$*" >&2; exit 1; }

sudo_if_needed() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "This needs root, and sudo is not installed."
    sudo "$@"
  fi
}

# --- 1. Node ---------------------------------------------------------------

command -v node >/dev/null 2>&1 ||
  die "Node is not installed. Get Node ${MIN_NODE_MAJOR} LTS from https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node ${MIN_NODE_MAJOR}+ is required (found $(node -v)). Levix stores everything in SQLite, which Node only ships with itself from ${MIN_NODE_MAJOR} on."
fi

command -v npm >/dev/null 2>&1 || die "npm is not installed."
command -v systemctl >/dev/null 2>&1 ||
  die "This script installs a systemd service, and systemd isn't here. Run 'npm i -g ${PACKAGE}' and start 'levix' yourself."

say "Node $(node -v) — good."

# --- 2. The package --------------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  say "Installing ${PACKAGE}…"
else
  say "Installing ${PACKAGE} ${VERSION}…"
fi
sudo_if_needed npm install -g "${PACKAGE}@${VERSION}"

# Where did it land? `/usr/bin/env levix` in the unit would depend on systemd's
# PATH, which does not include nvm's prefix and is not guaranteed to include
# npm's. Resolve it now and write the real path into the unit.
LEVIX_BIN="$(command -v levix || true)"
if [ -z "$LEVIX_BIN" ]; then
  NPM_BIN="$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null)/bin"
  [ -x "${NPM_BIN}/levix" ] && LEVIX_BIN="${NPM_BIN}/levix"
fi
[ -n "$LEVIX_BIN" ] || die "levix installed but could not be found on PATH."
say "Installed at ${LEVIX_BIN}"

# --- 3. User and data directory -------------------------------------------

if ! id -u levix >/dev/null 2>&1; then
  say "Creating the levix system user…"
  sudo_if_needed useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin levix
fi

sudo_if_needed mkdir -p "$DATA_DIR"
sudo_if_needed chown -R levix:levix "$DATA_DIR"
# The database holds the WhatsApp session and the panel password hash. Nobody
# else on the machine has any business reading it.
sudo_if_needed chmod 750 "$DATA_DIR"

# --- 4. The service --------------------------------------------------------

say "Installing the systemd service…"

UNIT_SOURCE=""
for candidate in \
  "$(npm root -g 2>/dev/null)/${PACKAGE}/deploy/levix.service" \
  "$(dirname "$0")/levix.service"; do
  if [ -f "$candidate" ]; then UNIT_SOURCE="$candidate"; break; fi
done
[ -n "$UNIT_SOURCE" ] || die "Couldn't find the unit file to install."

# Written through a temp file in the same directory, then moved into place, so
# an interrupted run never leaves systemd a half-written unit. mktemp, not a
# predictable name in /tmp.
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT

sed "s|^ExecStart=.*|ExecStart=${LEVIX_BIN} --data ${DATA_DIR}|" "$UNIT_SOURCE" > "$TMP_UNIT"
grep -q "^ExecStart=${LEVIX_BIN}" "$TMP_UNIT" || die "Failed to set ExecStart in the unit file."

sudo_if_needed install -m 0644 -o root -g root "$TMP_UNIT" "$UNIT"

sudo_if_needed systemctl daemon-reload
sudo_if_needed systemctl enable "$SERVICE"
sudo_if_needed systemctl restart "$SERVICE"

# --- 5. Did it actually start? --------------------------------------------

started=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$SERVICE"; then started=1; break; fi
  sleep 1
done

if [ "$started" -ne 1 ]; then
  printf '\n  Levix was installed but the service did not start.\n\n'
  printf '  What systemd says:\n\n'
  sudo_if_needed systemctl status "$SERVICE" --no-pager --lines 20 || true
  printf '\n  Full log: journalctl -u %s -n 50\n\n' "$SERVICE"
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

  Levix is running.

    Control panel   http://${IP:-<this server>}:${PORT}/
    Data            ${DATA_DIR}
    Logs            journalctl -u ${SERVICE} -f

  Open the panel and pick a password. Opening it from another machine also
  asks for a setup code — this prints it:

    journalctl -u ${SERVICE} -n 40 | grep -A3 'Setup code'

  Then scan the QR from the Connection screen with WhatsApp.

EOF

# --- 6. A domain, if they want one now ------------------------------------

# Optional, and entirely skippable: an IP is a perfectly good way to run this,
# and `levix domain` works just as well next week. Only ask when there is
# somebody at the keyboard — piping this script into bash gives us no stdin.
if [ -t 0 ]; then
  printf '  The panel has no HTTPS of its own. Connect a domain now? [y/N] '
  read -r answer </dev/tty || answer=""
  case "$answer" in
    [yY]*)
      # One implementation, in the CLI. This script does not have its own.
      sudo_if_needed "$LEVIX_BIN" --data "$DATA_DIR" domain
      ;;
    *)
      printf '\n  Fine — run this whenever you are ready:\n\n    sudo levix --data %s domain bot.example.com\n\n' "$DATA_DIR"
      ;;
  esac
else
  printf '  To put it behind a domain with HTTPS:\n\n    sudo levix --data %s domain bot.example.com\n\n' "$DATA_DIR"
fi

printf '  If this server is on the public internet, do that (or put it behind\n'
printf '  your own reverse proxy) before sharing the panel address.\n\n'
