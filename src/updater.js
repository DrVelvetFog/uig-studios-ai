// updater.js — release updates via tauri-plugin-updater (signed with the project's
// minisign key; endpoint = latest.json on GitHub Releases, see tauri.conf.json).
// Thin wrapper so App.jsx has one call each for "check" and "install", and so a
// missing plugin (web preview, dev without the plugin) degrades to "no updates".
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** → { current, available: false } | { current, available: true, version, notes, date, update } */
export async function checkForUpdate() {
  let current = "";
  try { current = await getVersion(); } catch {}
  try {
    const update = await check();
    if (!update) return { current, available: false };
    return { current, available: true, version: update.version, notes: update.body || "", date: update.date || "", update };
  } catch (e) {
    return { current, available: false, error: String(e?.message || e) };
  }
}

/** Download + install; onProgress(fraction 0..1). Relaunches the app when done. */
export async function installUpdate(update, onProgress) {
  let total = 0, got = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Started") total = ev.data.contentLength || 0;
    else if (ev.event === "Progress") { got += ev.data.chunkLength || 0; if (total && onProgress) onProgress(Math.min(1, got / total)); }
    else if (ev.event === "Finished" && onProgress) onProgress(1);
  });
  await relaunch();
}
