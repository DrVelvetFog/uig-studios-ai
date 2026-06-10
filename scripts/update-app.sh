#!/bin/zsh
# update-app.sh — rebuild TonyAI from source and install to /Applications.
# Run directly, or via the in-app "Rebuild & update" button (logs to
# ~/.tonyai/logs/update.log in that case).
set -e
cd "$(dirname "$0")/.."

echo "[$(date '+%H:%M:%S')] Running tests…"
npm test
(cd src-tauri && cargo test --lib)

echo "[$(date '+%H:%M:%S')] Building release bundle (this takes a few minutes)…"
npm run tauri build

echo "[$(date '+%H:%M:%S')] Installing to /Applications…"
rm -rf /Applications/TonyAI.app
cp -R src-tauri/target/release/bundle/macos/TonyAI.app /Applications/

echo "[$(date '+%H:%M:%S')] ✅ TonyAI updated — quit and relaunch the app to use the new version."
