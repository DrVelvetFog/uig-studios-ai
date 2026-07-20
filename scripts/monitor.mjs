#!/usr/bin/env node
/**
 * TonyAI Background Monitor
 * Runs every 5 minutes via launchd.
 * Writes findings to ~/.tonyai/inbox.json
 * Sends macOS notifications for critical findings.
 */

import { execSync, execFileSync }             from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir }                            from "os";
import { join }                               from "path";
import { runOpsChecks, runDailyBrief }        from "./ops.mjs";

// launchd runs with a bare PATH (/usr/bin:/bin) — homebrew tools (pm2) and
// their `#!/usr/bin/env node` shebangs need /opt/homebrew/bin resolvable.
process.env.PATH = `/opt/homebrew/bin:${process.env.PATH || "/usr/bin:/bin"}`;

const HOME       = homedir();
const TONYAI_DIR = join(HOME, ".tonyai");
const INBOX      = join(TONYAI_DIR, "inbox.json");
const OLLAMA_URL = "http://127.0.0.1:11434";

// Ensure ~/.tonyai exists
mkdirSync(TONYAI_DIR, { recursive: true });

// ── Inbox helpers ─────────────────────────────────────────────────────────────

function loadInbox() {
  try { return JSON.parse(readFileSync(INBOX, "utf8")); } catch { return []; }
}

function saveInbox(items) {
  writeFileSync(INBOX, JSON.stringify(items.slice(0, 100), null, 2));
}

/**
 * Add a finding. Deduplicates: won't add the same source+title within
 * dedupMinutes (default 60). Returns true if the finding was new.
 */
function addFinding({ source, severity, title, body, context = "" }, dedupMinutes = 60) {
  const inbox = loadInbox();
  const cutoff = Date.now() - dedupMinutes * 60 * 1000;
  const exists = inbox.some(f =>
    f.source === source &&
    f.title  === title  &&
    new Date(f.timestamp).getTime() > cutoff
  );
  if (exists) return false;
  inbox.unshift({
    id:        `${source}-${Date.now()}`,
    source,
    severity,  // "critical" | "warning" | "info"
    title,
    body,
    context,
    timestamp: new Date().toISOString(),
    read:      false,
  });
  saveInbox(inbox);
  return true;
}

// ── macOS notification ────────────────────────────────────────────────────────

function notify(title, body) {
  // AppleScript string literal: escape backslash + double-quote. Passing the
  // script as an execFileSync arg (no shell) avoids the quoting breakage that
  // could surface Script Editor on alerts containing " or \.
  const esc = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const script = `display notification ${esc(body.slice(0, 200))} with title ${esc(title.slice(0, 80))}`;
  try {
    execFileSync("osascript", ["-e", script], { timeout: 5000 });
  } catch {}
}

// ── Shell helper ──────────────────────────────────────────────────────────────

function run(cmd, timeoutMs = 15000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: "utf8" });
  } catch(e) {
    return (e.stdout || "") + (e.stderr || "") || e.message || "";
  }
}

// ── LLM helper (non-blocking, best-effort) ────────────────────────────────────

async function llmAnalyze(systemPrompt, userContent, model = "hermes3") {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  "POST",
      signal:  controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream:   false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent  },
        ],
        options: { temperature: 0.1, num_ctx: 4096 },
      }),
    });
    const data = await res.json();
    return data.message?.content?.trim() || "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 1 — Arb bot health
// ══════════════════════════════════════════════════════════════════════════════

async function checkArbBot() {
  const status = run("pm2 describe sui-arb-bot --no-color");
  const logs   = run("pm2 logs sui-arb-bot --lines 100 --nostream --no-color");

  // ── Status flags ────────────────────────────────────────────────────────────
  const isStopped     = /│\s*status\s*│\s*stopped/i.test(status);
  const isErrored     = /│\s*status\s*│\s*errored/i.test(status);
  const restartsMatch = status.match(/│\s*restarts\s*│\s*(\d+)/i);
  const restarts      = restartsMatch ? parseInt(restartsMatch[1]) : 0;

  // ── Log flags ───────────────────────────────────────────────────────────────
  const has403        = /403|Forbidden/i.test(logs);
  const hasCircuit    = /circuit breaker/i.test(logs);
  const hasFatal      = /FATAL|uncaughtException|Cannot read prop|UnhandledPromise/i.test(logs);
  const hasTimeout    = /timed? ?out|ETIMEDOUT|ECONNREFUSED/i.test(logs);

  // ── Critical: bot stopped ───────────────────────────────────────────────────
  if (isStopped || isErrored) {
    const reason = has403    ? "HTTP 403 on RPC — endpoint blocked/rate-limited."
                 : hasFatal  ? "Fatal uncaught exception — check error logs."
                 : hasTimeout? "Connection timeout — RPC or DEX unreachable."
                 : "Unknown — check pm2 logs.";
    const isNew = addFinding({
      source:   "arb-bot-stopped",
      severity: "critical",
      title:    `sui-arb-bot is ${isErrored ? "errored" : "stopped"}`,
      body:     reason,
      context:  logs.slice(-3000),
    });
    if (isNew) notify("⚡ Arb Bot Down", reason);
    return; // no point running deeper checks if stopped
  }

  // ── Warning: high restarts ──────────────────────────────────────────────────
  if (restarts > 10) {
    const isNew = addFinding({
      source:   "arb-bot-restarts",
      severity: "warning",
      title:    `sui-arb-bot: ${restarts} total restarts`,
      body:     "High restart count — bot may be crash-looping. Check error log.",
      context:  logs.slice(-2000),
    }, 120); // only re-notify every 2h
    if (isNew) notify("⚡ Arb Bot Unstable", `${restarts} restarts`);
  }

  // ── Warning: circuit breaker ────────────────────────────────────────────────
  if (hasCircuit) {
    addFinding({
      source:   "arb-bot-circuit",
      severity: "warning",
      title:    "Circuit breaker triggered",
      body:     "3+ consecutive trade failures. Bot paused for 15 min. Check spreads and RPC.",
      context:  logs.slice(-1500),
    });
  }

  // ── Warning: 403 while running ──────────────────────────────────────────────
  if (has403) {
    addFinding({
      source:   "arb-bot-403",
      severity: "warning",
      title:    "HTTP 403 on RPC endpoint",
      body:     "Chainstack or RPC provider is returning 403. Check API key / quota.",
      context:  logs.slice(-1500),
    });
  }

  // ── LLM analysis: deeper pattern detection ──────────────────────────────────
  // Only run if Ollama is reachable (skip silently if not)
  const recentLogs = logs.split("\n").slice(-60).join("\n");
  const analysis = await llmAnalyze(
    `You monitor a Sui DeFi arbitrage bot. Analyze the log lines below.
Reply with ONE of:
  OK                         — if everything looks normal
  FINDING: <one line>        — if you spot something worth flagging

Flag: recurring errors, abnormal spread patterns, missed opportunities, degraded performance, RPC issues.
Do NOT flag: normal polling output, prices showing, negative spreads (those are expected and normal).
Be extremely conservative — only flag genuinely unusual things.`,
    recentLogs
  );

  if (analysis.startsWith("FINDING:")) {
    const summary = analysis.replace("FINDING:", "").trim();
    addFinding({
      source:   "arb-bot-insight",
      severity: "info",
      title:    summary.slice(0, 80),
      body:     summary,
      context:  recentLogs,
    }, 30); // dedup 30 min for LLM insights
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 2 — Ollama model staleness
// ══════════════════════════════════════════════════════════════════════════════

async function checkOllamaModels() {
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const now  = Date.now();

    const stale = (data.models || [])
      .filter(m => !/(embed|minilm|bge-|e5-|gte-)/i.test(m.name))
      .map(m => ({
        name: m.name,
        days: Math.floor((now - new Date(m.modified_at).getTime()) / 86_400_000),
      }))
      .filter(m => m.days > 45)
      .sort((a, b) => b.days - a.days);

    if (stale.length > 0) {
      addFinding({
        source:   "ollama-stale-models",
        severity: "info",
        title:    `${stale.length} Ollama model${stale.length > 1 ? "s" : ""} haven't been updated in 45+ days`,
        body:     stale.map(m => `${m.name.split(":")[0]} (${m.days}d)`).join(", "),
        context:  "",
      }, 24 * 60); // only once per day
    }
  } catch {
    // Ollama not running — not a finding, just skip
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 3 — Disk space
// ══════════════════════════════════════════════════════════════════════════════

async function checkDiskSpace() {
  const output = run("df -h ~ | tail -1");
  const pct    = parseInt(output.match(/(\d+)%/)?.[1] || "0");

  if (pct >= 90) {
    const isNew = addFinding({
      source:   "disk-critical",
      severity: "critical",
      title:    `Disk at ${pct}% — critical`,
      body:     "Nearly full. Ollama model pulls and arb bot logs may fail.",
      context:  output,
    }, 60);
    if (isNew) notify("💾 Disk Space Critical", `${pct}% used`);
  } else if (pct >= 80) {
    addFinding({
      source:   "disk-warning",
      severity: "warning",
      title:    `Disk at ${pct}% — getting full`,
      body:     "Consider clearing old logs, model files, or TonyAI exports.",
      context:  output,
    }, 24 * 60);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  const ts = new Date().toISOString();
  console.log(`[tonyai-monitor] ${ts} — running checks`);

  const results = await Promise.allSettled([
    checkArbBot(),
    checkOllamaModels(),
    checkDiskSpace(),
    runOpsChecks({ addFinding, notify, run }),
    runDailyBrief({ addFinding, llmAnalyze, run }),
  ]);

  results.forEach((r, i) => {
    const names = ["arb-bot", "ollama-models", "disk-space", "ops", "daily-brief"];
    if (r.status === "rejected") {
      console.error(`[tonyai-monitor] ${names[i]} check failed:`, r.reason?.message || r.reason);
    }
  });

  console.log(`[tonyai-monitor] done`);
}

main();
