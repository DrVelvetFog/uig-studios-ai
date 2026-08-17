#!/bin/zsh
# update-app.sh — rebuild UIG Studios AI from source and install to /Applications.
# Run directly, or via the in-app "Rebuild & update" button (logs to
# ~/.uigai/logs/update.log in that case).
set -e
cd "$(dirname "$0")/.."

echo "[$(date '+%H:%M:%S')] Running tests…"
npm test
(cd src-tauri && cargo test --lib)

echo "[$(date '+%H:%M:%S')] Building release bundle (this takes a few minutes)…"
npm run tauri build

echo "[$(date '+%H:%M:%S')] Installing to /Applications…"
rm -rf "/Applications/UIG Studios AI.app"
cp -R "src-tauri/target/release/bundle/macos/UIG Studios AI.app" /Applications/

echo "[$(date '+%H:%M:%S')] ✅ UIG Studios AI updated — quit and relaunch the app to use the new version."
