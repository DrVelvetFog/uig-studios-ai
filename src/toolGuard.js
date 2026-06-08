// ── Tool safety guard ─────────────────────────────────────────────────────────
// Pure, dependency-free functions that gate the agent's side-effecting tools.
//
// Two layers:
//   1. HARD DENYLIST  — dangerousReason() / protectedPathReason(): catastrophic or
//      sensitive operations that are blocked ALWAYS, even when the interactive
//      approval prompt is turned off. Non-bypassable.
//   2. APPROVAL GATE  — isMutatingTool(): which tools should trigger the "Allow /
//      Deny" prompt when confirmCmds is on (handled in the UI layer).
//
// Design bias: block CATASTROPHIC / CREDENTIAL operations only. Normal dev work
// (`rm -rf node_modules`, writing project files, `npm install`) must pass through,
// otherwise the agent becomes useless. Tests in toolGuard.test.js lock this in.

// Tools that change state on disk / the system, or whose effect is unknown (MCP).
// These trigger the approval prompt; read-only tools (search, read, list, git_*) do not.
export const MUTATING_TOOLS = new Set([
  "run_command",
  "python_exec",
  "write_file",
]);

export function isMutatingTool(name) {
  if (!name) return false;
  if (name.startsWith("mcp__")) return true; // unknown side effects → always confirm
  return MUTATING_TOOLS.has(name);
}

// System directories that should never be written to or recursively deleted.
const SYSTEM_DIRS = [
  "/System", "/usr", "/bin", "/sbin", "/etc", "/var",
  "/Library", "/private", "/Applications", "/cores", "/opt",
];

// Home-relative sensitive locations (matched by path segment).
const SENSITIVE_SEGMENTS = [
  "/.ssh/", "/.aws/", "/.gnupg/", "/.gpg/", "/.kube/", "/.docker/",
  "/Library/Keychains/", "/Library/LaunchAgents/", "/Library/LaunchDaemons/",
];

// Sensitive files by basename (credentials, shell init, scheduler).
const SENSITIVE_BASENAMES = new Set([
  ".zshrc", ".bashrc", ".bash_profile", ".profile", ".zprofile", ".zshenv",
  ".gitconfig", ".netrc", ".npmrc", ".pypirc", ".env",
  "authorized_keys", "known_hosts", "id_rsa", "id_ed25519", "crontab", "sudoers",
]);

function basename(p) {
  const cleaned = String(p || "").replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

// Normalize a user/LLM-supplied path enough to reason about it (does NOT touch fs).
function normPath(p) {
  let s = String(p || "").trim();
  // Strip surrounding quotes the model sometimes adds.
  s = s.replace(/^['"]|['"]$/g, "");
  // Expand ~ and $HOME to a sentinel home so segment checks are uniform.
  s = s.replace(/^~(?=\/|$)/, "/__HOME__");
  s = s.replace(/\$HOME\b/g, "/__HOME__");
  s = s.replace(/\$\{HOME\}/g, "/__HOME__");
  return s;
}

// Returns a human-readable reason string if writing to `path` is forbidden, else null.
export function protectedPathReason(path) {
  const raw = String(path || "").trim();
  if (!raw) return "empty path";
  const s = normPath(path);

  // Writing to the filesystem root itself.
  if (s === "/" || /^\/__HOME__\/?$/.test(s)) return "the path is a top-level directory";

  // Absolute system directories.
  for (const dir of SYSTEM_DIRS) {
    if (s === dir || s.startsWith(dir + "/")) return `'${dir}' is a protected system directory`;
  }

  // Sensitive home segments (credentials, keychains, launch agents).
  const probe = s + (s.endsWith("/") ? "" : "/");
  for (const seg of SENSITIVE_SEGMENTS) {
    if (probe.includes(seg)) return `'${seg.replace(/\//g, "")}' holds credentials or system config`;
  }

  // Sensitive files by name (shell init, keys, credentials).
  if (SENSITIVE_BASENAMES.has(basename(s))) return `'${basename(s)}' is a sensitive credential/config file`;

  return null;
}

// Catastrophic command / code patterns. Targets the OPERATION + a dangerous TARGET,
// not the operation alone — so `rm -rf node_modules` passes but `rm -rf ~` does not.
export function dangerousReason(text) {
  const cmd = String(text || "");
  if (!cmd.trim()) return null;

  // Fork bomb.
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd)) return "fork bomb";

  // rm -rf (any flag order) targeting root, home, wildcards at root, or system dirs.
  if (/\brm\b[^\n|;&]*\s-[a-z]*[rf][a-z]*\b/i.test(cmd)) {
    if (/\brm\b[^\n|;&]*\s(-[a-z]*\s+)*(\/|~|\/\*|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+\/?\s*$|\.\s*$|\*\s*$)/i.test(cmd)
        || /\brm\b[^\n|;&]*\s(\/System|\/usr|\/bin|\/sbin|\/etc|\/var|\/Library|\/private|\/Applications)\b/i.test(cmd)
        || /\brm\b[^\n|;&]*\s~\/?(\s|$)/i.test(cmd)) {
      return "recursive delete of a root, home, or system path";
    }
  }

  // Disk / device destruction.
  if (/\bmkfs\b/i.test(cmd)) return "filesystem format (mkfs)";
  if (/\bdd\b[^\n]*\bof=\/dev\/(disk|sd|rdisk|nvme)/i.test(cmd)) return "raw write to a disk device (dd)";
  if (/>\s*\/dev\/(sd|disk|rdisk|nvme)/i.test(cmd)) return "redirect into a disk device";

  // Recursive permission / ownership changes on root, home, or system dirs.
  if (/\bchmod\b[^\n]*\s-[a-z]*R[a-z]*[^\n]*\s(\/|~|\$HOME)(\s|$)/i.test(cmd)
      || /\bchmod\b[^\n]*\s-[a-z]*R[a-z]*[^\n]*\s(\/System|\/usr|\/etc|\/Library|\/var|\/bin)\b/i.test(cmd)) {
    return "recursive chmod on a system/root path";
  }
  if (/\bchown\b[^\n]*\s-[a-z]*R[a-z]*[^\n]*\s(\/|~|\$HOME)(\s|$)/i.test(cmd)
      || /\bchown\b[^\n]*\s-[a-z]*R[a-z]*[^\n]*\s(\/System|\/usr|\/etc|\/Library|\/var|\/bin)\b/i.test(cmd)) {
    return "recursive chown on a system/root path";
  }

  // Piping a remote script straight into a shell.
  if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i.test(cmd)) return "executing a remote script piped into a shell";

  // Python destructive calls on root/home.
  if (/shutil\.rmtree\s*\(\s*['"]?(\/|~)/.test(cmd)) return "shutil.rmtree on a root/home path";
  if (/shutil\.rmtree\s*\(\s*os\.path\.expanduser\s*\(\s*['"]~/.test(cmd)) return "shutil.rmtree on the home directory";
  if (/os\.system\s*\(\s*['"][^'"]*\brm\b[^'"]*\s-[a-z]*[rf][a-z]*[^'"]*\s(\/|~)/.test(cmd)) return "os.system shelling out to a destructive rm";

  return null;
}

// Combined guard for a single tool call. Returns { blocked, reason }.
// `args` is the parsed argument object for the tool.
export function guardToolCall(name, args = {}) {
  if (name === "run_command") {
    const r = dangerousReason(args.command);
    if (r) return { blocked: true, reason: r };
  } else if (name === "python_exec") {
    const r = dangerousReason(args.code);
    if (r) return { blocked: true, reason: r };
  } else if (name === "write_file") {
    const r = protectedPathReason(args.path);
    if (r) return { blocked: true, reason: r };
  }
  return { blocked: false };
}

// Short human-readable detail shown in the approval prompt for each tool.
export function toolApprovalDetail(name, args = {}) {
  if (name === "run_command") return String(args.command || "");
  if (name === "write_file")  return `write → ${args.path || "?"}`;
  if (name === "python_exec") return String(args.code || "").split("\n")[0].slice(0, 120);
  if (name.startsWith("mcp__")) {
    let a = args;
    try { a = typeof args === "string" ? JSON.parse(args) : args; } catch { /* keep */ }
    return JSON.stringify(a).slice(0, 120);
  }
  return "";
}
