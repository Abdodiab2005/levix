#!/usr/bin/env bash
# Ship one generated installer to the download server.
#
#   scripts/deploy-installer.sh <installer-file> <version> <stable:yes|no>
#
# Everything about *where* it goes comes from the environment, so no host, user,
# path or key is written down in this repository:
#
#   LEVIX_DEPLOY_HOST         the download server
#   LEVIX_DEPLOY_USER         a deployment-only account (never root)
#   LEVIX_DEPLOY_SSH_KEY      that account's private key
#   LEVIX_DEPLOY_KNOWN_HOSTS  the server's public host key
#   LEVIX_DEPLOY_PORT         optional, default 22
#   LEVIX_DEPLOY_ROOT         optional, default /var/www/levix-downloads
#
# This half is deliberately thin: it uploads a file and runs
# scripts/publish-installer.sh on the other end. All of the logic that can
# damage a live installer lives in that script, where the test suite can run it.

set -euo pipefail

installer="${1:-}"
version="${2:-}"
stable="${3:-no}"

die() { printf '\nerror: %s\n\n' "$*" >&2; exit 1; }

[ -n "$installer" ] && [ -n "$version" ] || die "usage: deploy-installer.sh <file> <version> <stable:yes|no>"
[ -f "$installer" ] || die "no such installer: $installer"

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.]*)?$' ||
  die "not a version: '$version'"
case "$stable" in yes|no) : ;; *) die "stable must be yes or no" ;; esac

for required in LEVIX_DEPLOY_HOST LEVIX_DEPLOY_USER LEVIX_DEPLOY_SSH_KEY LEVIX_DEPLOY_KNOWN_HOSTS; do
  # The name, never the value.
  [ -n "${!required:-}" ] || die "${required} is not set"
done

port="${LEVIX_DEPLOY_PORT:-22}"
root="${LEVIX_DEPLOY_ROOT:-/var/www/levix-downloads}"
printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$' || die "LEVIX_DEPLOY_PORT is not a port"
printf '%s' "$root" | grep -Eq '^/[A-Za-z0-9/._-]+$' || die "LEVIX_DEPLOY_ROOT is not a plain absolute path"
case "$root" in *..*) die "LEVIX_DEPLOY_ROOT must not contain '..'" ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
[ -f "${here}/publish-installer.sh" ] || die "publish-installer.sh is missing next to this script"

# The key and the known_hosts entry only ever exist in a private directory that
# this script removes on the way out, whatever happens.
work="$(mktemp -d)"
chmod 700 "$work"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

key="${work}/key"
hosts="${work}/known_hosts"
umask 077
# A key pasted into a secret usually loses its trailing newline; ssh refuses it.
printf '%s\n' "${LEVIX_DEPLOY_SSH_KEY%$'\n'}" > "$key"
printf '%s\n' "${LEVIX_DEPLOY_KNOWN_HOSTS%$'\n'}" > "$hosts"
chmod 600 "$key" "$hosts"

# Host verification stays on. An unknown or changed host key fails the release
# instead of handing the private key to whatever answered.
ssh_opts=(
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$hosts"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=20
  -i "$key"
)

target="${LEVIX_DEPLOY_USER}@${LEVIX_DEPLOY_HOST}"
staged="${root}/.incoming/levix-v${version}-install.sh"

printf '\n· uploading v%s to %s\n' "$version" "$root"

ssh "${ssh_opts[@]}" -p "$port" "$target" "mkdir -p '${root}/.incoming'" ||
  die "could not prepare ${root}/.incoming on the server"

scp "${ssh_opts[@]}" -P "$port" "$installer" "${target}:${staged}" ||
  die "upload failed — nothing on the server was changed"

printf '· publishing\n\n'

# The staged file is still just a staged file until this succeeds.
ssh "${ssh_opts[@]}" -p "$port" "$target" \
  "bash -s -- '${root}' '${version}' '${staged}' '${stable}'" < "${here}/publish-installer.sh" ||
  die "publishing failed on the server — read the output above for what was and was not written"

printf '\n· done\n\n'
