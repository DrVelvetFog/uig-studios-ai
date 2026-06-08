// ── Lightweight diagnostic logging ────────────────────────────────────────────
// Mirrors messages to the console AND persists them (fire-and-forget) to
// ~/.tonyai/logs/tonyai.log via the Rust `append_log` command, so tool failures
// and uncaught errors leave a trail beyond the chat transcript.
import { invoke } from "@tauri-apps/api/core";

// Pure formatter — exported so it can be unit-tested without the Tauri runtime.
export function formatLogLine(level, message, meta) {
  const ts  = new Date().toISOString();
  const lvl = String(level || "info").toUpperCase();
  let line  = `${ts} [${lvl}] ${String(message ?? "")}`;
  if (meta !== undefined && meta !== null && meta !== "") {
    let m;
    try { m = typeof meta === "string" ? meta : JSON.stringify(meta); }
    catch { m = String(meta); }
    if (m && m !== "{}") line += ` | ${m}`;
  }
  return line;
}

export function log(level, message, meta) {
  const line = formatLogLine(level, message, meta);
  if (level === "error")      console.error(line);
  else if (level === "warn")  console.warn(line);
  else                        console.log(line);
  // Persist without blocking; never let logging throw into callers.
  try { invoke("append_log", { line }).catch(() => {}); } catch { /* no-op */ }
  return line;
}

export const logError = (message, meta) => log("error", message, meta);
export const logWarn  = (message, meta) => log("warn",  message, meta);
export const logInfo  = (message, meta) => log("info",  message, meta);

let installed = false;
// Register global handlers so uncaught errors / promise rejections are recorded.
export function installGlobalErrorLogging() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    log("error", `Uncaught error: ${e.message}`, { src: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    log("error", `Unhandled promise rejection: ${r && r.message ? r.message : String(r)}`);
  });
}
