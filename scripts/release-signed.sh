#!/bin/zsh
# release-signed.sh — build a code-signed (and, with credentials, notarized) UIG Studios AI.app.
#
#   ./scripts/release-signed.sh                 # auto-detect identity, notarize if creds present
#   ./scripts/release-signed.sh --dev-ok        # allow an "Apple Development" identity (NOT distributable)
#   ./scripts/release-signed.sh --install       # also copy the result to /Applications
#   ./scripts/release-signed.sh --release       # also publish a GitHub Release (dmg, updater tar.gz+sig, latest.json)
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

DEV_OK=0; INSTALL=0; RELEASE=0
for a in "$@"; do case "$a" in --dev-ok) DEV_OK=1;; --install) INSTALL=1;; --release) RELEASE=1;; esac; done

# Notarization + updater-signing creds live outside the repo, same convention as the app's secrets.
[[ -f "$HOME/.tonyai/secret-notary.env" ]] && source "$HOME/.tonyai/secret-notary.env"
[[ -f "$HOME/.tonyai/secret-updater.env" ]] && source "$HOME/.tonyai/secret-updater.env"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"   # updater artifacts get signed
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo "Updater signing: key at $TAURI_SIGNING_PRIVATE_KEY_PATH"
else
  echo "Updater signing: NO KEY (updater .tar.gz/.sig will not be produced) — see ~/.tonyai/secret-updater.env"
fi
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

# ── Release artifacts: rename (no spaces — GitHub mangles them), write latest.json for the updater ──
VER=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
REPO_SLUG="DrVelvetFog/tonyai"
OUT="src-tauri/target/release/bundle/release-v$VER"; rm -rf "$OUT"; mkdir -p "$OUT"
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg | head -1)
cp "$DMG" "$OUT/UIG-Studios-AI_${VER}_aarch64.dmg"
TGZ=$(ls "src-tauri/target/release/bundle/macos/"*.app.tar.gz 2>/dev/null | head -1 || true)
if [[ -n "$TGZ" && -f "$TGZ.sig" ]]; then
  cp "$TGZ" "$OUT/UIG-Studios-AI_${VER}_aarch64.app.tar.gz"
  cp "$TGZ.sig" "$OUT/UIG-Studios-AI_${VER}_aarch64.app.tar.gz.sig"
  python3 - "$OUT" "$VER" "$REPO_SLUG" <<'PY'
import json, sys, datetime
out, ver, slug = sys.argv[1:]
sig = open(f"{out}/UIG-Studios-AI_{ver}_aarch64.app.tar.gz.sig").read().strip()
notes = ""
try:
    notes = open("RELEASE_NOTES.md").read().strip()
except FileNotFoundError:
    pass
json.dump({
  "version": ver,
  "notes": notes,
  "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "platforms": { "darwin-aarch64": {
      "signature": sig,
      "url": f"https://github.com/{slug}/releases/download/v{ver}/UIG-Studios-AI_{ver}_aarch64.app.tar.gz" } }
}, open(f"{out}/latest.json", "w"), indent=2)
print(f"latest.json → v{ver} darwin-aarch64")
PY
else
  echo "⚠️  No updater artifacts (.app.tar.gz + .sig) — updater signing key missing?"
fi
ls -1 "$OUT"

if [[ $RELEASE -eq 1 ]]; then
  echo "[$(date '+%H:%M:%S')] Publishing GitHub Release v$VER…"
  NOTES_ARG=(--generate-notes); [[ -f RELEASE_NOTES.md ]] && NOTES_ARG=(--notes-file RELEASE_NOTES.md)
  gh release create "v$VER" --repo "$REPO_SLUG" --title "UIG Studios AI $VER" "${NOTES_ARG[@]}" "$OUT"/* \
    && echo "✅ Released: https://github.com/$REPO_SLUG/releases/tag/v$VER (updater endpoint: releases/latest/download/latest.json)"
fi

if [[ $INSTALL -eq 1 ]]; then
  rm -rf "/Applications/UIG Studios AI.app" && cp -R "$APP" /Applications/
  echo "✅ Installed to /Applications/UIG Studios AI.app — quit and relaunch."
fi
