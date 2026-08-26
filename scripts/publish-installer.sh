#!/usr/bin/env bash
# Put one generated installer in place on the download server.
#
#   publish-installer.sh <root> <version> <staged-file> <stable:yes|no>
#
# This runs ON the server — scripts/deploy-installer.sh pipes it there over ssh
# — and it is the only thing that ever writes to the public download directory.
# It is a separate file so it can be run against a temporary directory in the
# test suite, which is the only way to check the part that can corrupt a live
# installer.
#
# Layout it maintains:
#
#   <root>/install.sh          the latest stable installer (a moving alias)
#   <root>/install/vX.Y.Z.sh   immutable, one per release, never rewritten
#   <root>/install.version     which release install.sh currently is
#
# Rules it enforces:
#   · a versioned file is written once — a second, different build of the same
#     version is refused, an identical one is a no-op
#   · nothing is published before it parses as shell
#   · every replacement is a rename onto the target, never a write over it
#   · install.sh never moves backwards to an older release

set -euo pipefail

root="${1:-}"
version="${2:-}"
staged="${3:-}"
stable="${4:-no}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Every write goes through a temporary sibling. If one of them dies half way,
# it goes with it rather than sitting in a directory that is served publicly.
tmp=""
cleanup() {
  if [ -n "$tmp" ] && [ -f "$tmp" ]; then rm -f "$tmp"; fi
  return 0
}
trap cleanup EXIT

[ -n "$root" ] && [ -n "$version" ] && [ -n "$staged" ] ||
  die "usage: publish-installer.sh <root> <version> <staged-file> <stable:yes|no>"

# Second gate. The tag was validated where it came from; it is validated again
# here because this is the process that turns it into a path.
case "$version" in
  *[!0-9A-Za-z.-]* | "" ) die "refusing a version with unexpected characters: '$version'" ;;
esac
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.]*)?$' ||
  die "not a version: '$version'"

case "$root" in
  /*) : ;;
  *) die "the download root must be an absolute path: $root" ;;
esac
case "$root$staged" in *..*) die "refusing a path containing '..'" ;; esac
[ -d "$root" ] || die "download root does not exist: $root"
[ -f "$staged" ] || die "no staged installer at $staged"
[ -s "$staged" ] || die "the staged installer is empty"

# The staged file must be the one this deployment uploaded, under this root.
case "$staged" in
  "$root"/.incoming/*) : ;;
  *) die "the staged installer must be under $root/.incoming/" ;;
esac

# --- validate before anything is published ---------------------------------

head -c 2 "$staged" | grep -q '#!' || die "the staged installer has no shebang"
bash -n "$staged" || die "the staged installer is not valid shell"
grep -qx "VERSION=\"${version}\"" "$staged" ||
  die "the staged installer is not pinned to ${version}"

mkdir -p "$root/install"

versioned="$root/install/v${version}.sh"
latest="$root/install.sh"
marker="$root/install.version"

# --- the immutable versioned copy ------------------------------------------

if [ -f "$versioned" ]; then
  if cmp -s "$staged" "$versioned"; then
    printf 'unchanged  %s\n' "$versioned"
  else
    die "$versioned already exists with different content — versioned installers are immutable"
  fi
else
  tmp="$(mktemp "$root/install/.incoming.XXXXXX")"
  cat "$staged" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$versioned"
  printf 'published  %s\n' "$versioned"
fi

# --- the moving stable alias ------------------------------------------------

if [ "$stable" != "yes" ]; then
  printf 'skipped    %s (prerelease)\n' "$latest"
  rm -f "$staged"
  exit 0
fi

# A slow release job must not drag install.sh back to an older version because
# it finished after a newer one. Only compare stable versions — prereleases
# never reach this point.
if [ -f "$marker" ]; then
  current="$(tr -d ' \t\r\n' < "$marker")"
  if [ -n "$current" ] && [ "$current" != "$version" ]; then
    newest="$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)"
    if [ "$newest" != "$version" ]; then
      printf 'skipped    %s (already %s, refusing to go back to %s)\n' "$latest" "$current" "$version"
      rm -f "$staged"
      exit 0
    fi
  fi
fi

# Written as a sibling and renamed: a reader either gets the whole old file or
# the whole new one, and an interrupted deployment leaves neither truncated.
tmp="$(mktemp "$root/.install.sh.XXXXXX")"
if ! { cat "$versioned" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$latest"; }; then
  rm -f "$tmp"
  printf 'PARTIAL: %s was published but %s was not updated\n' "$versioned" "$latest" >&2
  exit 1
fi

tmp="$(mktemp "$root/.install.version.XXXXXX")"
printf '%s\n' "$version" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$marker"

rm -f "$staged"
printf 'published  %s (now %s)\n' "$latest" "$version"
