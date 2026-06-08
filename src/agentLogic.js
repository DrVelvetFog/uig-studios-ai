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

// Adds a contextual hint to raw tool error messages so the model can self-correct.
export function enrichToolError(fnName, rawError) {
  const e = String(rawError);
  const hints = {
    "read_file":    "Try list_dir on the parent directory first to confirm the path exists.",
    "write_file":   "Ensure the path is under $HOME. The directory will be created automatically.",
    "run_command":  "Check the exact command syntax. Use list_dir to confirm paths before running.",
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
export function neededSearchButSkipped(userPrompt, toolSteps) {
  if (!CURRENT_INFO_RE.test(userPrompt)) return false;
  const usedSearch = toolSteps.some(s =>
    s.name === "web_search" || s.name === "deep_search" || s.name === "fetch_url"
  );
  return !usedSearch;
}

export function evaluateStopCondition(loopToolSteps) {
  // Flatten: direct steps + any subagent sub-steps (nested one level deep)
  const allSteps = loopToolSteps.flatMap(s => [s, ...(s.subSteps || [])]);

  // Did we write any code file?
  const wroteCode = loopToolSteps.some(s => {
    if (s.name === "write_file") {
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
