/**
 * TonyAI Ops — config-driven portfolio checks (Phase 1 of the ops console).
 *
 * Config:  ~/.tonyai/ops.json        (seeded from scripts/ops-default.json on first run;
 *                                     edit freely — read every run; delete to re-seed)
 * State:   ~/.tonyai/ops-state.json  (current status per check — the Ops panel reads this)
 * History: ~/.tonyai/ops-history.jsonl (one snapshot line per run, capped ~2000 lines)
 *
 * Alerting philosophy: findings are raised on status TRANSITIONS only
 * (up→down, down→up), never on every failing tick. Severity per check
 * comes from config; "critical" also fires a macOS notification.
 *
 * Check types:
 *   http             — GET url, up on 2xx. metric = latency ms.
 *   sui-balance      — suix_getBalance; down when below minBalanceSui. metric = SUI.
 *   sui-object-field — read a u64 field off a shared object; info finding when it
 *                      INCREASES (growth signal, e.g. PoR total_minted). metric = value.
 *   pm2              — local pm2 process states. expect: "online" | "not-errored" | "report"
 *                      ("report" records status but never alerts).
 *   ssh-pm2-absent   — assert a process is NOT running on a remote box (BatchMode ssh).
 *                      down = it came back. alertUnknown: warn when box unreachable.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HOME           = homedir();
const TONYAI_DIR     = join(HOME, ".tonyai");
const CONFIG_PATH    = join(TONYAI_DIR, "ops.json");
const STATE_PATH     = join(TONYAI_DIR, "ops-state.json");
const HISTORY_PATH   = join(TONYAI_DIR, "ops-history.jsonl");
const DEFAULT_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "ops-default.json");

// launchd PATH lacks /opt/homebrew/bin — resolve pm2 explicitly
const PM2_BIN = existsSync("/opt/homebrew/bin/pm2") ? "/opt/homebrew/bin/pm2" : "pm2";

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// ── Check implementations ─────────────────────────────────────────────────────

async function httpCheck(c) {
  const t0 = Date.now();
  try {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(c.timeoutMs || 15000), redirect: "follow" });
    const ms = Date.now() - t0;
    return res.ok
      ? { status: "up",   detail: `${res.status} in ${ms}ms`, metric: ms }
      : { status: "down", detail: `HTTP ${res.status}` };
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timeout after ${c.timeoutMs || 15000}ms`
              : (e.cause?.code || e.message);
    return { status: "down", detail: why };
  }
}

async function suiRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function suiBalanceCheck(c) {
  try {
    const r   = await suiRpc(c.rpc, "suix_getBalance", [c.address]);
    const sui = Number(r.totalBalance) / 1e9;
    const min = c.minBalanceSui ?? 0.2;
    return sui < min
      ? { status: "down", detail: `${sui.toFixed(3)} SUI — below min ${min}`, metric: sui }
      : { status: "up",   detail: `${sui.toFixed(3)} SUI`, metric: sui };
  } catch (e) {
    return { status: "unknown", detail: `RPC: ${e.message}` };
  }
}

async function suiObjectFieldCheck(c) {
  try {
    const r = await suiRpc(c.rpc, "sui_getObject", [c.objectId, { showContent: true }]);
    const v = Number(r.data?.content?.fields?.[c.field]);
    if (Number.isNaN(v)) return { status: "unknown", detail: `field ${c.field} not found` };
    return { status: "up", detail: `${c.field} = ${v}`, metric: v };
  } catch (e) {
    return { status: "unknown", detail: `RPC: ${e.message}` };
  }
}

let pm2Cache; // one jlist per monitor run
function pm2List(run) {
  if (pm2Cache !== undefined) return pm2Cache;
  try {
    const out   = run(`${PM2_BIN} jlist`, 20000);
    const start = out.indexOf("[");
    pm2Cache = start >= 0 ? JSON.parse(out.slice(start)) : null;
  } catch { pm2Cache = null; }
  return pm2Cache;
}

function pm2Check(c, run) {
  const list = pm2List(run);
  if (!list) return { status: "unknown", detail: "pm2 unavailable" };
  const states = {};
  for (const name of c.processes) {
    const p = list.find(x => x.name === name);
    states[name] = p ? p.pm2_env?.status : "absent";
  }
  const summary = Object.entries(states).map(([n, s]) => `${n}: ${s}`).join(", ");
  if (c.expect === "report") return { status: "up", detail: summary };
  const bad = Object.entries(states).filter(([, s]) =>
    c.expect === "online" ? s !== "online" : (s === "errored" || s === "absent"));
  return bad.length
    ? { status: "down", detail: summary }
    : { status: "up",   detail: summary };
}

function sshPm2AbsentCheck(c, run) {
  const key = (c.sshKey || "").replace(/^~/, HOME);
  const out = run(
    `ssh -i ${key} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${c.host} "pm2 jlist 2>/dev/null || echo MISSING_PM2"`,
    30000
  );
  if (out.includes("MISSING_PM2")) return { status: "up", detail: "no pm2 on box (nothing running)" };
  const start = out.indexOf("[");
  if (start < 0) return { status: "unknown", detail: `box unreachable: ${out.trim().slice(0, 120) || "no output"}` };
  let list;
  try { list = JSON.parse(out.slice(start)); }
  catch { return { status: "unknown", detail: "unparseable pm2 output from box" }; }
  const p = list.find(x => x.name === c.process);
  if (!p) return { status: "up", detail: `${c.process} absent on box (good)` };
  const s = p.pm2_env?.status;
  return s === "online"
    ? { status: "down", detail: `${c.process} is RUNNING on the box` }
    : { status: "down", detail: `${c.process} present on box (${s})` };
}

// ── Runner ────────────────────────────────────────────────────────────────────

const DOWN_WORD = { "sui-balance": "LOW", "ssh-pm2-absent": "ALERT" }; // default "DOWN"

export async function runOpsChecks({ addFinding, notify, run }) {
  if (!existsSync(CONFIG_PATH)) {
    try { copyFileSync(DEFAULT_CONFIG, CONFIG_PATH); }
    catch (e) { console.error("[ops] cannot seed ops.json:", e.message); return; }
  }
  const config = loadJson(CONFIG_PATH, null);
  if (!config?.checks?.length) return;

  const state = loadJson(STATE_PATH, { checks: {} });
  pm2Cache = undefined;
  const now = Date.now();

  const due = config.checks.filter(c => {
    const last = state.checks[c.id]?.lastRun || 0;
    return now - last >= (c.intervalMin ?? 5) * 60000 - 30000; // 30s slack for launchd jitter
  });

  await Promise.allSettled(due.map(async c => {
    let r;
    try {
      switch (c.type) {
        case "http":             r = await httpCheck(c); break;
        case "sui-balance":      r = await suiBalanceCheck(c); break;
        case "sui-object-field": r = await suiObjectFieldCheck(c); break;
        case "pm2":              r = pm2Check(c, run); break;
        case "ssh-pm2-absent":   r = sshPm2AbsentCheck(c, run); break;
        default:                 r = { status: "unknown", detail: `unknown check type: ${c.type}` };
      }
    } catch (e) {
      r = { status: "unknown", detail: e.message };
    }

    const prev    = state.checks[c.id] || {};
    // first observation of a non-up state counts as a transition (a check added
    // for something already broken should still alert once)
    const changed = prev.status ? prev.status !== r.status : r.status !== "up";
    const label   = c.label || c.id;

    // Growth signal: a tracked on-chain counter went up
    if (c.type === "sui-object-field" &&
        typeof prev.metric === "number" && typeof r.metric === "number" && r.metric > prev.metric) {
      addFinding({
        source:   `ops-${c.id}-growth`,
        severity: "info",
        title:    `${c.project}: ${c.field} ${prev.metric} → ${r.metric}`,
        body:     c.growthNote || `On-chain counter increased for ${c.project}.`,
        context:  "",
      }, 1);
    }

    if (changed && c.expect !== "report") {
      if (r.status === "down") {
        const sev   = c.severity || "warning";
        const word  = DOWN_WORD[c.type] || "DOWN";
        const isNew = addFinding({
          source:   `ops-${c.id}`,
          severity: sev,
          title:    `${c.project}: ${label} ${word}`,
          body:     r.detail + (c.note ? ` — ${c.note}` : ""),
          context:  "",
        }, 30);
        if (isNew && sev === "critical") notify(`🔴 ${c.project}`, `${label}: ${r.detail}`);
      } else if (r.status === "up" && prev.status === "down") {
        addFinding({
          source:   `ops-${c.id}-recovered`,
          severity: "info",
          title:    `${c.project}: ${label} recovered`,
          body:     r.detail,
          context:  "",
        }, 5);
      } else if (r.status === "unknown" && c.alertUnknown) {
        addFinding({
          source:   `ops-${c.id}-unknown`,
          severity: "warning",
          title:    `${c.project}: ${label} state UNKNOWN`,
          body:     r.detail,
          context:  "",
        }, 12 * 60);
      }
    }

    state.checks[c.id] = {
      ...r,
      project:    c.project,
      label,
      lastRun:    now,
      lastChange: changed ? now : (prev.lastChange || now),
    };
  }));

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  // Full-picture snapshot line (statuses + numeric metrics) for trends/sparklines
  const snapshot = {
    ts: new Date(now).toISOString(),
    s:  Object.fromEntries(Object.entries(state.checks).map(([id, v]) => [id, v.status])),
    m:  Object.fromEntries(Object.entries(state.checks)
          .filter(([, v]) => typeof v.metric === "number")
          .map(([id, v]) => [id, v.metric])),
  };
  appendFileSync(HISTORY_PATH, JSON.stringify(snapshot) + "\n");
  capHistory();

  console.log(`[ops] ${due.length}/${config.checks.length} checks ran:`,
    Object.entries(state.checks).map(([id, v]) => `${id}=${v.status}`).join(" "));
}

function capHistory() {
  try {
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    if (lines.length > 3000) writeFileSync(HISTORY_PATH, lines.slice(-2000).join("\n") + "\n");
  } catch {}
}
