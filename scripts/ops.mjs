/**
 * UIG Studios AI Ops — config-driven portfolio checks (Phase 1 of the ops console).
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
 *   sui-balance      — SUI balance over GraphQL; down when below minBalanceSui. metric = SUI.
 *   sui-object-field — read a u64 field off a shared object; info finding when it
 *                      INCREASES (growth signal, e.g. an on-chain counter). metric = value.
 *   http-field       — read a numeric dot-path field from a JSON HTTP response (e.g.
 *                      mints.count off /api/health). gauge; metric = value.
 *   Any counter check (http-field / sui-object-field) with `maxPerInterval` ALSO gets
 *   rate-anomaly alerting: a warning (or its severity) when growth in one interval
 *   exceeds the threshold — mint-volume / L2-accrual spikes. Daily-reset aware.
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

// Mysten retired JSON-RPC on the public fullnodes (mainnet week of 2026-07-20; the
// testnet nodes answer the same "Method not found … migrate to gRPC or GraphQL").
// GraphQL is the dependency-free replacement — plain POST over fetch, so this script
// stays stdlib-only (gRPC would drag @mysten/sui into an app with no runtime JS deps).
// The endpoint is derived from the network named in the existing `rpc` URL, so old
// configs keep working untouched; override per check with `graphql`.
const SUI_GRAPHQL = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
  devnet:  "https://graphql.devnet.sui.io/graphql",
};

function suiGraphqlUrl(c) {
  if (c.graphql) return c.graphql;
  const net = Object.keys(SUI_GRAPHQL).find((n) => String(c.rpc || "").includes(n));
  if (!net) throw new Error(`no GraphQL endpoint for rpc "${c.rpc}" — set "graphql" on the check`);
  return SUI_GRAPHQL[net];
}

async function suiGraphql(c, query) {
  const res = await fetch(suiGraphqlUrl(c), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  if (!data.data) throw new Error(`HTTP ${res.status}: empty GraphQL response`);
  return data.data;
}

async function suiBalanceCheck(c) {
  try {
    const coin = c.coinType || "0x2::sui::SUI";
    const d = await suiGraphql(c, `{ address(address: "${c.address}") {
      balance(coinType: "${coin}") { totalBalance } } }`);
    // An address the node has never seen returns null rather than an error — that is a
    // genuine zero balance (and, for a gas wallet, exactly the alert we want to fire).
    const sui = Number(d.address?.balance?.totalBalance ?? 0) / 1e9;
    const min = c.minBalanceSui ?? 0.2;
    return sui < min
      ? { status: "down", detail: `${sui.toFixed(3)} SUI — below min ${min}`, metric: sui }
      : { status: "up",   detail: `${sui.toFixed(3)} SUI`, metric: sui };
  } catch (e) {
    return { status: "unknown", detail: `GraphQL: ${e.message}` };
  }
}

// Read a numeric field (dot-path) out of a JSON HTTP response — e.g. mint volume or
// a rate derived from a counter (originally an attestor's /api/health). Pair with `maxPerInterval` for
// anomaly (rate-spike) alerting in the runner. Gauge: status stays "up" on success.
function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
async function httpFieldCheck(c) {
  try {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(c.timeoutMs || 15000), redirect: "follow" });
    if (!res.ok) return { status: "unknown", detail: `HTTP ${res.status}` };
    const v = Number(getPath(await res.json(), c.field));
    if (Number.isNaN(v)) return { status: "unknown", detail: `field ${c.field} missing/non-numeric` };
    return { status: "up", detail: `${c.field} = ${v}`, metric: v };
  } catch (e) {
    return { status: "unknown", detail: e.name === "TimeoutError" ? "timeout" : (e.cause?.code || e.message) };
  }
}

async function suiObjectFieldCheck(c) {
  try {
    // `contents { json }` is the GraphQL equivalent of showContent's fields map —
    // u64s still arrive as strings, so Number() does the same job it always did.
    const d = await suiGraphql(c, `{ object(address: "${c.objectId}") {
      asMoveObject { contents { json } } } }`);
    const v = Number(d.object?.asMoveObject?.contents?.json?.[c.field]);
    if (Number.isNaN(v)) return { status: "unknown", detail: `field ${c.field} not found` };
    return { status: "up", detail: `${c.field} = ${v}`, metric: v };
  } catch (e) {
    return { status: "unknown", detail: `GraphQL: ${e.message}` };
  }
}

// pm2 output can include "[PM2] ..." banner lines (daemon spawn, updates) before
// the JSON — find the first line that actually parses as a JSON array.
function parseJlist(out) {
  for (const line of (out || "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      try { return JSON.parse(t); } catch {}
    }
  }
  return null;
}

let pm2Cache; // one jlist per monitor run
function pm2List(run) {
  if (pm2Cache !== undefined) return pm2Cache;
  try { pm2Cache = parseJlist(run(`${PM2_BIN} jlist`, 20000)); }
  catch { pm2Cache = null; }
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
  const list = parseJlist(out);
  if (!list) return { status: "unknown", detail: `box unreachable or unparseable: ${out.trim().slice(0, 120) || "no output"}` };
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
        case "http-field":       r = await httpFieldCheck(c); break;
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
    if (c.type === "sui-object-field" && !(typeof c.maxPerInterval === "number") &&
        typeof prev.metric === "number" && typeof r.metric === "number" && r.metric > prev.metric) {
      addFinding({
        source:   `ops-${c.id}-growth`,
        severity: "info",
        title:    `${c.project}: ${c.field} ${prev.metric} → ${r.metric}`,
        body:     c.growthNote || `On-chain counter increased for ${c.project}.`,
        context:  "",
      }, 1);
    }

    // Rate anomaly: a tracked counter grew faster than maxPerInterval in one interval
    // (mint-volume / L2-accrual spike = possible gas-drain / sybil / farming). Works for
    // http-field and sui-object-field. Daily counters reset to 0, so a drop = a reset:
    // treat growth as the new value itself (0 → metric) rather than a negative.
    if (typeof c.maxPerInterval === "number" &&
        typeof prev.metric === "number" && typeof r.metric === "number") {
      const growth = r.metric >= prev.metric ? r.metric - prev.metric : r.metric;
      if (growth > c.maxPerInterval) {
        const sev = c.severity || "warning";
        const isNew = addFinding({
          source:   `ops-${c.id}-anomaly`,
          severity: sev,
          title:    `${c.project}: ${label} spike — +${growth} (> ${c.maxPerInterval}/interval)`,
          body:     (c.anomalyNote || `${label} grew by ${growth} since the last check — unusual rate.`) + (c.note ? ` — ${c.note}` : ""),
          context:  "",
        }, 60);
        if (isNew && sev === "critical") notify(`🟠 ${c.project} anomaly`, `${label}: +${growth} this interval`);
      }
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

  if (Array.isArray(config?.projectOrder)) state.projectOrder = config.projectOrder;   // Ops panel card-group order
  state.updatedAt = Date.now();
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

// ── Daily ops brief ───────────────────────────────────────────────────────────
// One info finding per day, first monitor run at/after BRIEF_HOUR local time.
// Digest of ops state + last-24h alerts + disk, summarized
// by the local model (llmAnalyze); falls back to the raw digest if Ollama is
// unavailable, so the brief always lands.

const BRIEF_PATH = join(TONYAI_DIR, "ops-brief.json");
const BRIEF_SYSTEM = `You are summarizing the daily status of the services this machine monitors
(everything defined in ~/.tonyai/ops.json, grouped by project, plus this Mac itself).
Write like you are texting a friend who runs all of this.

Include exactly:
1. One word health status (Excellent/Good/Warning/Critical)
2. Anything DOWN or unknown right now (or "all green")
3. Biggest problem in the last 24h
4. One specific thing to do today
5. Notable numbers (gas wallet, credentials minted, latencies) only if interesting

Under 120 words total. No jargon. Use only the data provided — never invent numbers.`;

export async function runDailyBrief({ addFinding, llmAnalyze, run }) {
  const briefHour = Number(process.env.TONYAI_BRIEF_HOUR ?? 9);
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const briefState = loadJson(BRIEF_PATH, {});
  if (now.getHours() < briefHour || briefState.lastBriefDay === dayKey) return;

  const lines = [];

  const state = loadJson(STATE_PATH, { checks: {} });
  const checks = Object.entries(state.checks);
  if (!checks.length) return; // nothing to brief on yet
  lines.push("CURRENT STATUS:");
  for (const [id, v] of checks) lines.push(`- ${v.project} / ${v.label}: ${v.status} (${v.detail})`);

  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const inbox = loadJson(join(TONYAI_DIR, "inbox.json"), []);
    const recent = inbox.filter(f =>
      new Date(f.timestamp).getTime() > cutoff && f.source !== "ops-daily-brief");
    if (recent.length) {
      lines.push("", "ALERTS IN LAST 24H:");
      recent.slice(0, 8).forEach(f => lines.push(`- [${f.severity}] ${f.title}`));
    } else {
      lines.push("", "ALERTS IN LAST 24H: none");
    }
  } catch {}

  const df = run("df -h ~ | tail -1");
  const pct = df.match(/(\d+)%/)?.[1];
  if (pct) lines.push("", `DISK: ${pct}% used`);

  // (An arb-bot telemetry section used to live here. The bot is retired — its db is
  // frozen, so the line only ever reported a growing "idle" age. Removed 2026-07-30.)

  const digest = lines.join("\n");
  const summary = await llmAnalyze(BRIEF_SYSTEM, digest);
  const body = summary || digest.slice(0, 900);

  addFinding({
    source:   "ops-daily-brief",
    severity: "info",
    title:    `Daily ops brief — ${dayKey}`,
    body,
    context:  digest,
  }, 20 * 60);

  writeFileSync(BRIEF_PATH, JSON.stringify({ lastBriefDay: dayKey }, null, 2));
  console.log(`[ops] daily brief posted for ${dayKey}${summary ? "" : " (raw digest — LLM unavailable)"}`);
}
