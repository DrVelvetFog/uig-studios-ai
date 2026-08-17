// evidence.js — evidence tiers for UIG Studios AI agent turns (https://github.com/DrVelvetFog/evidence-tier)
//
// Every tool step gets a tier by WHAT KIND OF TOOL IT IS — stamped by code, never
// by the model (ev R7: never infer `ran` from prose):
//   ran   — executed something and observed the result (run_command, python_exec, run_background)
//   read  — read an artifact it can point to (read_file, fetch_url, git_*, RAG, sessions)
//   told  — another party asserted it (web_search, deep_search, MCP tools, subagent reports)
//   null  — an action, not evidence (write_file, edit_file, process_kill, propose_plan, …)
// The turn's completion claim ("TASK_COMPLETE") gets the strongest tier its steps support:
// ran > read > told > recalled. This is the honest counterpart of the stop-condition rule
// "no completion without [exit 0]" — recorded per turn, exportable as an in-toto Statement.

export const RAN_TOOLS  = new Set(["run_command", "python_exec", "run_background"]);
export const READ_TOOLS = new Set(["read_file", "list_dir", "search_files", "git_status", "git_diff", "git_log", "git_blame",
                                   "fetch_url", "search_knowledge", "search_sessions", "process_status", "process_list"]);
export const TOLD_TOOLS = new Set(["web_search", "deep_search", "spawn_subagent"]);
export const RANK = { ran: 3, read: 2, told: 1, recalled: 0 };
export const PREDICATE_TYPE = "https://github.com/DrVelvetFog/evidence-tier/v0";

export function tierForTool(name) {
  if (RAN_TOOLS.has(name)) return "ran";
  if (READ_TOOLS.has(name)) return "read";
  if (TOLD_TOOLS.has(name) || String(name).startsWith("mcp__")) return "told";
  return null;
}

/** Non-cryptographic 32-bit FNV-1a — sync fallback binding when crypto.subtle is unavailable. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ("00000000" + h.toString(16)).slice(-8);
}
export async function digestOf(str) {
  const s = String(str ?? "");
  try {
    if (globalThis.crypto?.subtle) {
      const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return { sha256: [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("") };
    }
  } catch {}
  return { fnv1a: fnv1a(s) };
}

const exitOf = (result) => { const m = /\[exit (-?\d+)\]/.exec(String(result || "")); return m ? Number(m[1]) : null; };

/** One evidence descriptor per step. */
export function stepEvidence(step) {
  const tier = tierForTool(step.name);
  const a = step.args || {};
  if (tier === "ran") {
    const ex = exitOf(step.result);
    return { tier, kind: "action",
             ref: step.rv ? `rv:${step.rv.root}#${step.rv.seq}` : `tool:${step.name}`,
             exit: ex, ok: ex === 0 && step.status !== "error" };
  }
  if (tier === "read") {
    const uri = a.path ? `file:${a.path}` : a.url ? a.url : a.dir ? `file:${a.dir}` : a.repo_path ? `file:${a.repo_path}` : `tool:${step.name}`;
    return { tier, kind: "artifact", uri, ok: step.status !== "error" };
  }
  if (tier === "told") return { tier, kind: "party", who: `tool:${step.name}`, ok: step.status !== "error" };
  return { tier: null, kind: "action", ref: `tool:${step.name}` };
}

/** Flatten steps + one level of subagent sub-steps. */
export function flattenSteps(steps) {
  return (steps || []).flatMap(s => [s, ...(s.subSteps || [])]);
}

/** Counts by tier for a turn. */
export function evidenceSummary(steps) {
  const c = { ran: 0, read: 0, told: 0, action: 0, failed: 0 };
  for (const s of flattenSteps(steps)) {
    const e = stepEvidence(s);
    if (e.tier) { c[e.tier]++; if (e.ok === false) c.failed++; } else c.action++;
  }
  return c;
}

/** Strongest tier the turn's steps actually support for a completion claim. */
export function completionTier(steps) {
  let best = "recalled";
  for (const s of flattenSteps(steps)) {
    const e = stepEvidence(s);
    if (!e.tier || e.ok === false) continue;
    if (RANK[e.tier] > RANK[best]) best = e.tier;
  }
  return best;
}

/** One-line human summary: "ran 2 · read 3 · told 1". */
export function evidenceLine(steps) {
  const c = evidenceSummary(steps);
  const parts = ["ran", "read", "told"].filter(t => c[t]).map(t => `${t} ${c[t]}`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? parts.join(" · ") : "no evidence (recalled)";
}

/** Build the per-turn in-toto Statement (evidence-tier predicate). Async for sha256. */
export async function buildTurnStatement({ turnId, model, mode, finalText, steps, at = new Date().toISOString() }) {
  const flat = flattenSteps(steps);
  const subjectDigest = await digestOf(finalText || "");
  const evidence = [];
  const ledger = [];
  for (const s of flat) {
    const e = stepEvidence(s);
    const d = await digestOf(s.result || "");
    ledger.push({ tool: s.name, tier: e.tier, ref: e.ref || e.uri || e.who || null, exit: e.exit ?? null, ok: e.ok ?? null, digest: d });
    if (!e.tier || e.ok === false) continue;
    if (e.tier === "ran") evidence.push({ kind: "action", ref: e.ref, digest: d });
    else if (e.tier === "read") evidence.push({ kind: "artifact", uri: e.uri, digest: d });
    else evidence.push({ kind: "party", who: e.who, at });
  }
  const tier = completionTier(steps);
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `turn:${turnId}`, digest: subjectDigest }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      producer: { kind: "agent", tool: "uig-studios-ai", model, mode, session: turnId },
      claims: [{
        id: "final", text: String(finalText || "").replace(/\s+/g, " ").slice(0, 200),
        tier, evidence: tier === "recalled" ? [] : evidence.filter(e => (tier === "ran" ? e.kind === "action" : tier === "read" ? e.kind !== "party" : true)),
      }],
      ledger,
    },
  };
}
