// rv.js — journal shell-command effects with rv (https://github.com/DrVelvetFog/reversible)
// so "Undo command effects" exists alongside the file checkpoint's "Revert".
//
// TonyAI's checkpoint snapshots only write_file/edit_file. run_command is one-way.
// rv snapshots the git worktree before/after a command and can restore per path.
// We derive the scope (a git repo) from the command itself (leading `cd <dir>`) or
// the last directory a tool touched this turn; with no scope, the command runs raw.
// Pure helpers only — App.jsx does the invoking.

export const RV_BIN_DEFAULT = "~/reversible/rv";

/** Leading `cd <dir>` (optionally quoted, ~ allowed) → dir, else null. */
export function leadingCd(command) {
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\|\||$)/.exec(command || "");
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/** Pick the directory rv should scope to. */
export function rvScope(command, lastToolDir) {
  return leadingCd(command) || lastToolDir || null;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Build the wrapped shell line. `dir` may start with ~ (the shell expands it). */
export function rvWrapCommand(command, dir, { rvBin = RV_BIN_DEFAULT, actor = "tonyai" } = {}) {
  const d = /^~(\/|$)/.test(dir) ? dir : shq(dir);   // leave ~ bare so sh expands it
  return `cd ${d} && ${rvBin} wrap --actor ${shq(actor)} -- ${shq(command)}`;
}

/** Parse rv's stderr report out of a tool result. → {seq, changed, root} | null */
export function parseRvReport(output) {
  const m = /rv: #(\d+) (changed|no-change) root=(\S+)/.exec(String(output || ""));
  return m ? { seq: Number(m[1]), changed: m[2] === "changed", root: m[3] } : null;
}

/** Remove the rv report line from what the model sees (it's UI metadata, not output). */
export function stripRvReport(output) {
  return String(output || "").replace(/\n?(?:STDERR: )?rv: #\d+ (?:changed|no-change) root=\S+\n?/, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Undo command for one journaled action (run through the same shell tool). */
export function rvUndoCommand(action, { rvBin = RV_BIN_DEFAULT, dryRun = false } = {}) {
  return `cd ${shq(action.root)} && ${rvBin} undo ${Number(action.seq)}${dryRun ? " --dry-run" : ""}`;
}
export function rvShowCommand(action, { rvBin = RV_BIN_DEFAULT } = {}) {
  return `cd ${shq(action.root)} && ${rvBin} show ${Number(action.seq)}`;
}
