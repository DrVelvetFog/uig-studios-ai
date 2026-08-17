#!/usr/bin/env node
// okf-check — validate ~/UIG-AI/Projects/memory as an OKF v0.2 bundle and report
// evidence-tag coverage per file. Usage: node scripts/okf-check.mjs [dir] [--strict]
// Exit 1 on frontmatter errors (always) or on any warning (--strict).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateBundle, TIERS } from "../src/memoryOkf.js";

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--")) || path.join(os.homedir(), "UIG-AI", "Projects", "memory");
const strict = args.includes("--strict");

if (!fs.existsSync(dir)) { console.log(`no memory dir at ${dir}`); process.exit(0); }
const files = {};
for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) files[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), "utf8");

const r = validateBundle(files);
console.log(`OKF bundle: ${dir}`);
for (const e of r.bundleErrors) console.log(`  BUNDLE ERROR ${e}`);
let warnings = 0;
for (const [name, v] of Object.entries(r.results)) {
  const s = v.stats;
  const tiers = TIERS.map(t => s.byTier[t] ? `${t}=${s.byTier[t]}` : null).filter(Boolean).join(" ");
  console.log(`  ${v.ok ? "ok  " : "FAIL"} ${name}.md  status=${s.status}  facts=${s.facts} tagged=${s.tagged}${tiers ? "  (" + tiers + ")" : ""}`);
  for (const e of v.errors) console.log(`       ERROR ${e}`);
  for (const w of v.warnings) { console.log(`       warn  ${w}`); warnings++; }
}
const bad = !r.ok || (strict && warnings > 0);
console.log(bad ? "NOT OK" : "OK");
process.exit(bad ? 1 : 0);
