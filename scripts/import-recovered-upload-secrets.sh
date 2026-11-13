#!/usr/bin/env bash
# Run on the owner's workstation only, after downloading the encrypted Actions artifact.
# Decrypts to memory and securely imports all four secrets into private levix-plus.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: bash scripts/import-recovered-upload-secrets.sh <levix-upload-key-recovery.age>" >&2
  exit 2
fi
for cmd in age gh python3; do
  command -v "$cmd" >/dev/null || {
    echo "Missing $cmd; install it locally before importing" >&2
    exit 2
  }
done

key="${HOME}/.config/levix/upload-recovery.agekey"
if [ ! -r "$key" ]; then
  echo "Owner's age private key not found at $key" >&2
  exit 2
fi

gh auth status --hostname github.com >/dev/null || {
  echo "GitHub CLI is not authenticated; run: gh auth login" >&2
  exit 2
}

# The age decryption goes directly to Python via stdin. No plaintext JSON or
# keystore files are ever written by this importer, logged or passed in argv.
age -d -i "$key" "$1" | python3 -c '
import base64, binascii, json, subprocess, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit("Decryption payload is not valid recovery JSON")
if not isinstance(data, dict) or data.get("schema") != 1 or data.get("repository") != "Abdodiab2005/levix":
    sys.exit("Unexpected recovery payload")
secrets = data.get("secrets", {})
expected = ("LEVIX_KEYSTORE_BASE64", "LEVIX_KEYSTORE_PASSWORD", "LEVIX_KEY_ALIAS", "LEVIX_KEY_PASSWORD")
if not isinstance(secrets, dict) or set(secrets) != set(expected):
    sys.exit("Recovery payload does not contain exactly the expected four secrets")
if any(not isinstance(secrets[key], str) or not secrets[key] for key in expected):
    sys.exit("One or more signing secrets are empty or invalid")
try:
    binary = base64.b64decode("".join(secrets["LEVIX_KEYSTORE_BASE64"].split()), validate=True)
    if not 100 <= len(binary) <= 1048576:
        raise ValueError()
except (ValueError, binascii.Error):
    sys.exit("Invalid upload keystore Base64")
repo = "Abdodiab2005/levix-plus"
for name in expected:
    process = subprocess.run(
        ["gh", "secret", "set", name, "--repo", repo, "--app", "actions"],
        input=secrets[name].encode("utf-8"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if process.returncode:
        sys.exit(f"Could not set {name}; verify GitHub CLI permissions. Values were not displayed.")
    print(f"Saved {name} to private levix-plus")
print("All four Android signing secrets transferred to the private repository.")
'
