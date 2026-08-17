// memoryOkf.js — UIG Studios AI memory files as Open Knowledge Format (OKF v0.2) concepts.
//
// Memory lives in ~/UIG-AI/Projects/memory/<name>.md (legacy ~/TonyAI-Projects/memory/ still recognised), one wiki-page per scope
// (global + per-mode). This module makes each page an OKF concept document:
// YAML frontmatter (type/title/generated/status/...) + markdown body, and gives
// every learned fact an inline evidence tag saying HOW the agent knows it:
//
//   - fact text [ran]                 executed and observed
//   - fact text [read: ~/x/README.md] read it in that artifact
//   - fact text [told: user]          a party asserted it
//   - fact text [recalled]            from the model's own memory
//
// Pure functions, no deps, no I/O — imported by App.jsx (stamp on write, strip
// on inject) and by scripts/okf-check.mjs (validate the bundle). See
// https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// and https://github.com/DrVelvetFog/evidence-tier/blob/main/OKF.md

export const OKF_VERSION = "0.2";
export const MEMORY_TYPE = "Memory";
export const TIERS = ["ran", "read", "told", "recalled", "inferred"];
export const RESERVED_NAMES = new Set(["index", "readme", "log"]); // not memory scopes

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export const FACT_TAG_RE = /\[(ran|read|told|recalled|inferred)(?::\s*([^\]]*?))?\]\s*$/;

/** Split "---\nyaml\n---\nbody" → { fm: {..}, fmRaw, body }. Tiny YAML subset: top-level
 *  `key: value`, `key: { a: b, c: d }` flow maps, and `key:` + indented `- item` / `- { … }` lists. */
export function parseFrontmatter(text) {
  const m = FM_RE.exec(text || "");
  if (!m) return { fm: null, fmRaw: "", body: text || "" };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (/^\s+-\s/.test(raw) && listKey) { fm[listKey].push(parseScalar(raw.replace(/^\s+-\s/, ""))); continue; }
    if (/^\s/.test(raw)) continue; // nested block maps unsupported → ignored, never fatal
    const i = raw.indexOf(":");
    if (i < 0) continue;
    const key = raw.slice(0, i).trim();
    const val = raw.slice(i + 1).trim();
    if (val === "") { fm[key] = []; listKey = key; continue; }
    listKey = null;
    fm[key] = parseScalar(val);
  }
  return { fm, fmRaw: m[0], body: text.slice(m[0].length) };
}

function parseScalar(v) {
  v = v.trim();
  if (/^\{.*\}$/.test(v)) {                       // flow map { a: b, c: d }
    const out = {};
    for (const part of splitTop(v.slice(1, -1))) {
      const j = part.indexOf(":");
      if (j > 0) out[part.slice(0, j).trim()] = parseScalar(part.slice(j + 1));
    }
    return out;
  }
  if (/^\[.*\]$/.test(v)) return splitTop(v.slice(1, -1)).map(parseScalar).filter(x => x !== "");
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  return v;
}
function splitTop(s) {                             // split on commas not inside {} [] or quotes
  const out = []; let depth = 0, q = null, cur = "";
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim());
}

/** Body without frontmatter — what gets injected into the system prompt. */
export function stripFrontmatter(text) {
  return parseFrontmatter(text).body;
}

/** Ensure OKF frontmatter exists and stamp generated:{by,at}. Idempotent; never touches the body.
 *  `by` follows the OKF actor convention: "human:<id>" or "<producer>/<version>". */
export function stampMemory(text, { name, by, at = new Date().toISOString(), title } = {}) {
  const { fm, body } = parseFrontmatter(text || "");
  const yaml = fm ? reserializeFrontmatter(text) : {};
  const lines = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(yaml, k);
  lines.push(`type: ${has("type") ? yaml.type : MEMORY_TYPE}`);
  lines.push(`title: ${has("title") ? yaml.title : (title || defaultTitle(name, body))}`);
  if (has("description")) lines.push(`description: ${yaml.description}`);
  lines.push(`generated: { by: ${by || "uig-studios-ai/agent"}, at: ${at} }`);
  lines.push(`status: ${has("status") ? yaml.status : "stable"}`);
  for (const [k, v] of Object.entries(yaml)) {
    if (["type", "title", "description", "generated", "status"].includes(k)) continue;
    lines.push(`${k}: ${v}`);                        // pass through unknown keys verbatim
  }
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\r?\n/, "")}`;
}

// Re-read raw frontmatter lines as key→rawValue so pass-through keeps the author's exact text.
function reserializeFrontmatter(text) {
  const m = FM_RE.exec(text); const out = {};
  if (!m) return out;
  let cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (/^\s/.test(raw) && cur) { out[cur] += "\n" + raw; continue; }
    const i = raw.indexOf(":"); if (i < 0) continue;
    cur = raw.slice(0, i).trim(); out[cur] = raw.slice(i + 1).trim();
  }
  return out;
}

function defaultTitle(name, body) {
  const h = /^#\s+(.+)$/m.exec(body || "");
  if (h) return h[1].trim();
  return name ? `${name} memory` : "memory";
}

/** Facts = bullet lines. Returns [{line, text, tier, ref}] — tier null when untagged. */
export function extractFacts(body) {
  const facts = [];
  (body || "").split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!/^[-*]\s+/.test(t)) return;
    const m = FACT_TAG_RE.exec(t);
    facts.push({ line: i + 1, text: t.replace(/^[-*]\s+/, "").replace(FACT_TAG_RE, "").trim(),
                 tier: m ? m[1] : null, ref: m && m[2] ? m[2].trim() : null });
  });
  return facts;
}

/** Validate one memory concept. Returns { ok, errors[], warnings[], stats }. */
export function validateMemory(text, { name } = {}) {
  const errors = [], warnings = [];
  const { fm, body } = parseFrontmatter(text || "");
  if (!fm) errors.push("no frontmatter (OKF concept requires a `type`)");
  else {
    if (!fm.type) errors.push("frontmatter missing `type`");
    if (!fm.title) warnings.push("no `title`");
    if (!fm.generated || typeof fm.generated !== "object" || !fm.generated.by) errors.push("missing `generated: { by, at }`");
    else if (!fm.generated.at || isNaN(Date.parse(fm.generated.at))) errors.push("`generated.at` is not an ISO 8601 datetime");
    if (fm.status && !["draft", "stable", "deprecated"].includes(fm.status)) errors.push(`invalid status ${fm.status}`);
    if (fm.generated?.by && !/^(human:|process:|[\w.-]+\/)/.test(String(fm.generated.by))) warnings.push(`generated.by "${fm.generated.by}" is not in the OKF actor convention (human:<id> | process:<id> | <producer>/<version>)`);
  }
  const facts = extractFacts(body);
  const tagged = facts.filter(f => f.tier);
  const byTier = Object.fromEntries(TIERS.map(t => [t, tagged.filter(f => f.tier === t).length]));
  for (const f of tagged) {
    if (f.tier === "read" && !f.ref) warnings.push(`line ${f.line}: [read] without a path/url is a told (ev R2)`);
    if (f.tier === "recalled" && f.ref) warnings.push(`line ${f.line}: [recalled] should not carry a ref`);
  }
  if (facts.length && !tagged.length) warnings.push(`${facts.length} facts, none carry an evidence tag (treated as told)`);
  return { ok: errors.length === 0, errors, warnings, name,
           stats: { facts: facts.length, tagged: tagged.length, byTier, status: fm?.status || "stable" } };
}

/** Bundle-level check: files = { name: text }. Requires an index.md with okf_version. */
export function validateBundle(files) {
  const results = {}; let ok = true;
  const idx = files.index;
  const bundleErrors = [];
  if (idx == null) bundleErrors.push("no index.md at bundle root");
  else {
    const { fm } = parseFrontmatter(idx);
    if (!fm || String(fm.okf_version) !== OKF_VERSION) bundleErrors.push(`index.md must declare okf_version: "${OKF_VERSION}"`);
  }
  for (const [name, text] of Object.entries(files)) {
    if (RESERVED_NAMES.has(name.toLowerCase())) continue;
    results[name] = validateMemory(text, { name });
    ok = ok && results[name].ok;
  }
  return { ok: ok && bundleErrors.length === 0, bundleErrors, results };
}

/** Is this path a UIG Studios AI memory file? (write sites use this to decide whether to stamp) */
export function isMemoryPath(p) {
  return /(^|\/)(TonyAI-Projects|UIG-AI\/Projects)\/memory\/[^/]+\.md$/.test(String(p || "").replace(/\\/g, "/"));
}
export function memoryNameFromPath(p) {
  const m = /(?:TonyAI-Projects|UIG-AI\/Projects)\/memory\/([^/]+)\.md$/.exec(String(p || "").replace(/\\/g, "/"));
  return m ? m[1] : null;
}
