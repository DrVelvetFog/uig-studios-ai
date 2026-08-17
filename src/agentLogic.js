// ── Pure agent-loop / tool-dispatch logic ───────────────────────────────────
// Extracted from App.jsx so it can be unit-tested without React/Tauri.
// No imports from react or @tauri-apps here — keep this module pure.

export const CODE_EXTS_SET = new Set([".py",".js",".ts",".jsx",".tsx",".sh",".rb",".go",".rs",".java",".c",".cpp",".mjs"]);
// ── Tool use reliability helpers ──────────────────────────────────────────────

// Extracts a tool call from raw model text — handles JSON embedded in prose,
// multiple key-name conventions (tool/name/function, args/arguments/parameters/input),
// and markdown fences. Much more robust than the old startsWith("{") check.
// Extract balanced JSON objects from text regardless of nesting depth.
// String-aware: skips braces inside quoted strings (including escaped quotes)
// so {"content":"return {\"x\":1}"} is handled correctly.
export function extractJsonObjects(text) {
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc)              { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true;  continue; }
    if (ch === '"')       { inStr = !inStr; continue; }
    if (inStr)            { continue; }
    if (ch === "{")       { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) { objects.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return objects;
}

export function extractToolCallFromText(text) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();

  // Extract all balanced JSON objects from the text (handles nested args)
  const candidates = extractJsonObjects(cleaned);

  // If the whole cleaned string is JSON, prefer it first
  if (cleaned.startsWith("{")) candidates.unshift(cleaned);

  for (const candidate of candidates) {
    try {
      const p = JSON.parse(candidate);
      // Accept any of these key formats models use
      const toolName = p.tool || p.name || p.function || p.tool_name || p.action;
      const toolArgs = p.args || p.arguments || p.parameters || p.input || p.params || {};
      if (toolName && typeof toolName === "string") {
        return [{ function: { name: toolName, arguments: toolArgs }, id: `ptc_${Date.now()}` }];
      }
    } catch { /* not valid JSON, try next */ }
  }
  return null;
}

// Validates that required tool arguments are present before executing.
// Returns { valid: true } or { valid: false, error: "..." }
export function validateToolArgs(fnName, fnArgs, allTools) {
  const tool = allTools.find(t => t.function?.name === fnName);
  if (!tool) return { valid: false, error: `Tool '${fnName}' does not exist. Available tools: ${allTools.map(t => t.function?.name).join(", ")}` };
  const required = tool.function?.parameters?.required || [];
  const missing = required.filter(k => fnArgs[k] === undefined || fnArgs[k] === null || fnArgs[k] === "");
  if (missing.length > 0) {
    const props = tool.function?.parameters?.properties || {};
    const hints = missing.map(k => `${k} (${props[k]?.description || "required"})`).join(", ");
    return { valid: false, error: `Missing required arguments for ${fnName}: ${hints}` };
  }
  return { valid: true };
}

// ── Approval diff builder ─────────────────────────────────────────────────────
// Produces a compact line diff for the tool-approval prompt.
// edit_file: trims common leading/trailing lines, adds one line of context each side.
// write_file: renders the (capped) new content as all-added lines.
// Returns [{ sign: "-"|"+"|" ", text }]. Empty array = nothing to show.
const DIFF_MAX_LINES = 40;

export function buildEditDiff(oldStr, newStr) {
  const a = String(oldStr ?? "").split("\n");
  const b = String(newStr ?? "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const lines = [];
  if (start > 0) lines.push({ sign: " ", text: a[start - 1] });
  for (let i = start; i < endA; i++) lines.push({ sign: "-", text: a[i] });
  for (let i = start; i < endB; i++) lines.push({ sign: "+", text: b[i] });
  if (endA < a.length) lines.push({ sign: " ", text: a[endA] });

  if (lines.length > DIFF_MAX_LINES) {
    const omitted = lines.length - DIFF_MAX_LINES;
    return [...lines.slice(0, DIFF_MAX_LINES), { sign: " ", text: `… ${omitted} more line${omitted === 1 ? "" : "s"}` }];
  }
  return lines;
}

export function buildWriteDiff(content) {
  const b = String(content ?? "").split("\n");
  const lines = b.slice(0, DIFF_MAX_LINES).map(text => ({ sign: "+", text }));
  if (b.length > DIFF_MAX_LINES) {
    const omitted = b.length - DIFF_MAX_LINES;
    lines.push({ sign: " ", text: `… ${omitted} more line${omitted === 1 ? "" : "s"}` });
  }
  return lines;
}

// Builds the diff (or null) shown in the approval prompt for a pending tool call.
export function approvalDiffFor(name, args = {}) {
  if (name === "edit_file")  return buildEditDiff(args.old_string, args.new_string);
  if (name === "write_file") return buildWriteDiff(args.content);
  return null;
}

// Adds a contextual hint to raw tool error messages so the model can self-correct.
export function enrichToolError(fnName, rawError) {
  const e = String(rawError);
  const hints = {
    "read_file":    "Try list_dir on the parent directory first to confirm the path exists.",
    "write_file":   "Ensure the path is under $HOME. The directory will be created automatically.",
    "edit_file":    "read_file the target first and copy old_string EXACTLY (whitespace included). If it matches multiple places, add surrounding lines to make it unique.",
    "run_command":  "Check the exact command syntax. Use list_dir to confirm paths before running. For long builds pass timeout_seconds; for servers use run_background.",
    "run_background": "Check the command syntax. After starting, call process_status with the returned id to confirm it came up.",
    "process_status": "Use the exact id returned by run_background. Call process_list to see all known process ids.",
    "web_search":   "Try a more specific query or different keywords.",
    "fetch_url":    "The URL may be paywalled or unavailable. Try a different source from the search results.",
    "search_files": "Check that the directory exists and the pattern is valid regex.",
  };
  const hint = hints[fnName] || "Adjust the arguments and retry.";
  return `${e}\n\nHint: ${hint}`;
}

// Detects whether a prompt needed current information but web search was not used.
// Used to inject a correction nudge before accepting a final answer.
export const CURRENT_INFO_RE = /\b(?:current|latest|now|today|right now|price|status|recent|news|update|this week|2024|2025|2026|live|real.?time)\b/i;

// A search that was rate-limited or errored did not check the web, even though the
// tool call happened. Counting it would let the model satisfy this guard while
// answering a time-sensitive question from stale knowledge — the exact failure the
// guard exists to prevent. Matches the "SEARCH DID NOT RUN" / "UNCHECKED" wording
// the Rust search tool emits for blocked or failed lookups.
const SEARCH_DID_NOT_RUN_RE = /SEARCH DID NOT RUN|UNCHECKED/i;

export function neededSearchButSkipped(userPrompt, toolSteps) {
  if (!CURRENT_INFO_RE.test(userPrompt)) return false;
  const usedSearch = toolSteps.some(s =>
    (s.name === "web_search" || s.name === "deep_search" || s.name === "fetch_url") &&
    !SEARCH_DID_NOT_RUN_RE.test(String(s.result ?? ""))
  );
  return !usedSearch;
}

// ── Session cleanup selection ─────────────────────────────────────────────────
// Picks which sessions a bulk-cleanup action should delete. Session ids are
// Date.now() at creation, so age comes straight from the id.
//   olderThanDays > 0 → sessions created more than N days ago
//   olderThanDays === 0 → every session (i.e. "all except current")
// The active session (keepId) is never selected, and at least one session must
// survive — the UI guarantees keepId exists, so that invariant holds here.
export function selectSessionsForCleanup(sessions, { olderThanDays, keepId, now = Date.now() } = {}) {
  if (!Array.isArray(sessions) || olderThanDays === undefined || olderThanDays === null) return [];
  const cutoff = now - olderThanDays * 86_400_000;
  return sessions
    .filter(s => s && s.id !== keepId && Number(s.id) <= cutoff)
    .map(s => s.id);
}

// ── Telemetry aggregation ─────────────────────────────────────────────────────
// Parses telemetry JSONL (one agent run per line) into per-model stats so you
// can see which local models actually complete agentic work.
export function aggregateTelemetry(jsonl) {
  const byModel = new Map();
  for (const line of String(jsonl || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let run;
    try { run = JSON.parse(t); } catch { continue; }
    if (!run?.model) continue;
    const m = byModel.get(run.model) || {
      model: run.model, runs: 0, completed: 0, errors: 0,
      totalLoops: 0, totalStopRejections: 0, totalDurationS: 0,
      completedRan: 0, completedWithTier: 0,   // evidence: of completed runs, how many rested on `ran`
    };
    m.runs++;
    if (run.outcome === "complete") {
      m.completed++;
      if (run.completionTier) { m.completedWithTier++; if (run.completionTier === "ran") m.completedRan++; }
    }
    if (run.outcome === "error")    m.errors++;
    m.totalLoops += Number(run.loops) || 0;
    m.totalStopRejections += Number(run.stopRejections) || 0;
    m.totalDurationS += Number(run.durationS) || 0;
    byModel.set(run.model, m);
  }
  return [...byModel.values()]
    .map(m => ({
      model: m.model,
      runs: m.runs,
      completionRate: m.runs ? Math.round((m.completed / m.runs) * 100) : 0,
      errorRate: m.runs ? Math.round((m.errors / m.runs) * 100) : 0,
      avgLoops: m.runs ? Math.round((m.totalLoops / m.runs) * 10) / 10 : 0,
      avgStopRejections: m.runs ? Math.round((m.totalStopRejections / m.runs) * 10) / 10 : 0,
      avgDurationS: m.runs ? Math.round(m.totalDurationS / m.runs) : 0,
      // % of completed runs whose completion claim is backed by an executed step (evidence tier `ran`);
      // null when no run has tier data yet (pre-evidence telemetry lines).
      ranRate: m.completedWithTier ? Math.round((m.completedRan / m.completedWithTier) * 100) : null,
    }))
    .sort((a, b) => b.runs - a.runs);
}

export function evaluateStopCondition(loopToolSteps) {
  // Flatten: direct steps + any subagent sub-steps (nested one level deep)
  const allSteps = loopToolSteps.flatMap(s => [s, ...(s.subSteps || [])]);

  // Did we write or edit any code file?
  const wroteCode = loopToolSteps.some(s => {
    if (s.name === "write_file" || s.name === "edit_file") {
      const ext = ("." + (s.args?.path || "").split(".").pop()).toLowerCase();
      return CODE_EXTS_SET.has(ext);
    }
    if (s.name === "spawn_subagent" && s.args?.role === "coder") return true;
    return false;
  });

  // Was run_command ever called?
  const ranSomething = allSteps.some(s => s.name === "run_command");

  // Did any run_command succeed ([exit 0])?
  const hasExitZero = allSteps.some(s =>
    s.name === "run_command" && /\[exit 0\]/.test(String(s.result || ""))
  );

  // Did any run_command fail (non-zero exit)?
  const hasNonZeroExit = allSteps.some(s =>
    s.name === "run_command" &&
    s.status !== "running" &&
    /\[exit -?\d+\]/.test(String(s.result || "")) &&
    !/\[exit 0\]/.test(String(s.result || ""))
  );

  if (wroteCode && !ranSomething) {
    return {
      canStop: false,
      reason: "You wrote code files but haven't run them yet. Execute the entry point with run_command and confirm [exit 0] before completing.",
    };
  }
  if (wroteCode && ranSomething && !hasExitZero && hasNonZeroExit) {
    return {
      canStop: false,
      reason: "The code ran but exited with a non-zero code. Read the error output, fix the file with write_file, and run again until you see [exit 0].",
    };
  }

  return { canStop: true, reason: "" };
}
