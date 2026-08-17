#!/bin/zsh
# release-signed.sh — build a code-signed (and, with credentials, notarized) UIG Studios AI.app.
#
#   ./scripts/release-signed.sh                 # auto-detect identity, notarize if creds present
#   ./scripts/release-signed.sh --dev-ok        # allow an "Apple Development" identity (NOT distributable)
#   ./scripts/release-signed.sh --install       # also copy the result to /Applications
#
# Identity: $APPLE_SIGNING_IDENTITY, else the first "Developer ID Application" in the keychain.
#           A "Developer ID Application" cert is what Gatekeeper on OTHER Macs requires.
#           Create one in Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application.
# Notarize: Tauri notarizes automatically when EITHER set is in the environment —
#           APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH   (App Store Connect API key; preferred)
#           APPLE_ID + APPLE_PASSWORD (app-specific) + APPLE_TEAM_ID
#           Without them the build is signed but not notarized (Gatekeeper still warns elsewhere).
set -euo pipefail
cd "$(dirname "$0")/.."

DEV_OK=0; INSTALL=0
for a in "$@"; do case "$a" in --dev-ok) DEV_OK=1;; --install) INSTALL=1;; esac; done

# Notarization creds live outside the repo, same convention as the app's secrets.
[[ -f "$HOME/.tonyai/secret-notary.env" ]] && source "$HOME/.tonyai/secret-notary.env"
[[ -n "${APPLE_API_KEY_PATH:-}" ]] && APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH/#\~/$HOME}" && export APPLE_API_KEY_PATH
if [[ -n "${APPLE_API_KEY:-}" && ! -f "${APPLE_API_KEY_PATH:-/nonexistent}" ]]; then
  echo "✗ APPLE_API_KEY_PATH not found: ${APPLE_API_KEY_PATH:-unset}"; exit 2
fi

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1 || true)
fi
if [[ -z "$identity" && $DEV_OK -eq 1 ]]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1 || true)
  [[ -n "$identity" ]] && echo "⚠️  Using a DEVELOPMENT identity — the app will run here but Gatekeeper on other Macs will refuse it."
fi
if [[ -z "$identity" ]]; then
  echo "✗ No 'Developer ID Application' identity in the keychain."
  echo "  Create one: Xcode → Settings → Accounts → (your Apple ID) → Manage Certificates → + → Developer ID Application"
  echo "  Then re-run. (Or pass --dev-ok to sign with an Apple Development identity for a local-only build.)"
  exit 2
fi
echo "Signing identity: $identity"
export APPLE_SIGNING_IDENTITY="$identity"

if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  echo "Notarization: App Store Connect API key (issuer ${APPLE_API_ISSUER})"
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "Notarization: Apple ID ${APPLE_ID} (team ${APPLE_TEAM_ID})"
else
  echo "Notarization: SKIPPED (no APPLE_API_KEY*/APPLE_ID* in env) — signed only."
fi

# A stale read-write DMG from a previous run breaks bundle_dmg.sh — detach it first.
for vol in $(hdiutil info 2>/dev/null | awk '/\/Volumes\/dmg\./ {print $NF}'); do hdiutil detach "$vol" -quiet || true; done

echo "[$(date '+%H:%M:%S')] Tests…"
npm test >/dev/null
(cd src-tauri && cargo test --lib -q)

echo "[$(date '+%H:%M:%S')] Building signed bundle…"
npm run tauri build -- --bundles app,dmg

APP="src-tauri/target/release/bundle/macos/UIG Studios AI.app"
echo "[$(date '+%H:%M:%S')] Verifying signature…"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=1 "$APP" 2>&1 | grep -E "^(Authority|TeamIdentifier|Timestamp|Runtime)" || true
if spctl --assess --type execute --verbose=2 "$APP" 2>&1; then
  echo "✅ Gatekeeper: accepted (signed + notarized)"
else
  echo "⚠️  Gatekeeper: not accepted — expected without notarization or with a Development identity."
fi
ls -1 src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true

if [[ $INSTALL -eq 1 ]]; then
  rm -rf "/Applications/UIG Studios AI.app" && cp -R "$APP" /Applications/
  echo "✅ Installed to /Applications/UIG Studios AI.app — quit and relaunch."
fi
