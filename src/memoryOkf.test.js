import { describe, it, expect } from "vitest";
import {
  parseFrontmatter, stripFrontmatter, stampMemory, extractFacts,
  validateMemory, validateBundle, isMemoryPath, memoryNameFromPath, OKF_VERSION,
} from "./memoryOkf.js";

const BODY = `# Global\n\n## Learned Facts\n- Tony prefers minimal code [told: user]\n- vitest run passes 242 tests [ran]\n- Ollama has no /api/tokenize [read: https://github.com/ollama/ollama/issues/12030]\n- W3C PROV has entity/activity/agent [recalled]\n- an untagged fact\n`;

describe("frontmatter", () => {
  it("parses flow maps, lists, scalars; strips cleanly", () => {
    const t = `---\ntype: Memory\ntitle: Global\ngenerated: { by: human:tony, at: 2026-08-17T15:00:00Z }\nstatus: stable\ntags:\n  - a\n  - b\nokf_version: "0.2"\n---\n# body\n`;
    const { fm, body } = parseFrontmatter(t);
    expect(fm.type).toBe("Memory");
    expect(fm.generated).toEqual({ by: "human:tony", at: "2026-08-17T15:00:00Z" });
    expect(fm.tags).toEqual(["a", "b"]);
    expect(fm.okf_version).toBe("0.2");
    expect(body).toBe("# body\n");
    expect(stripFrontmatter(t)).toBe("# body\n");
  });
  it("no frontmatter → body is whole text", () => {
    expect(parseFrontmatter("# x\n").fm).toBeNull();
    expect(stripFrontmatter("# x\n")).toBe("# x\n");
  });
});

describe("stampMemory", () => {
  it("adds OKF frontmatter to a bare file, title from H1", () => {
    const out = stampMemory(BODY, { name: "global", by: "tonyai/qwen2.5-coder:14b", at: "2026-08-17T15:00:00Z" });
    const { fm, body } = parseFrontmatter(out);
    expect(fm.type).toBe("Memory");
    expect(fm.title).toBe("Global");
    expect(fm.generated).toEqual({ by: "tonyai/qwen2.5-coder:14b", at: "2026-08-17T15:00:00Z" });
    expect(fm.status).toBe("stable");
    expect(body).toBe(BODY);
  });
  it("is idempotent, re-stamps generated only, preserves other keys and status", () => {
    const first = stampMemory(BODY, { name: "arb", by: "human:tony", at: "2026-01-01T00:00:00Z" })
      .replace("status: stable", "status: deprecated\ntags: [sui, arb]");
    const second = stampMemory(first, { name: "arb", by: "tonyai/agent", at: "2026-08-17T15:00:00Z" });
    const { fm, body } = parseFrontmatter(second);
    expect(fm.status).toBe("deprecated");
    expect(fm.tags).toEqual(["sui", "arb"]);
    expect(fm.generated.by).toBe("tonyai/agent");
    expect(fm.generated.at).toBe("2026-08-17T15:00:00Z");
    expect(body).toBe(BODY);
    expect(stampMemory(second, { by: "tonyai/agent", at: "2026-08-17T15:00:00Z" })).toBe(second);
  });
});

describe("facts + evidence tags", () => {
  it("extracts tiers and refs; untagged → null", () => {
    const f = extractFacts(BODY);
    expect(f.map(x => x.tier)).toEqual(["told", "ran", "read", "recalled", null]);
    expect(f[0].ref).toBe("user");
    expect(f[2].ref).toBe("https://github.com/ollama/ollama/issues/12030");
    expect(f[4].text).toBe("an untagged fact");
    expect(f[1].text).toBe("vitest run passes 242 tests");
  });
});

describe("validate", () => {
  it("valid stamped file passes with stats", () => {
    const r = validateMemory(stampMemory(BODY, { name: "global", by: "human:tony" }), { name: "global" });
    expect(r.ok).toBe(true);
    expect(r.stats).toMatchObject({ facts: 5, tagged: 4 });
    expect(r.stats.byTier).toMatchObject({ ran: 1, read: 1, told: 1, recalled: 1 });
  });
  it("bare file fails; bad status fails; read without ref warns", () => {
    expect(validateMemory(BODY).ok).toBe(false);
    const bad = `---\ntype: Memory\ngenerated: { by: human:t, at: 2026-08-17T15:00:00Z }\nstatus: bogus\n---\n- x [read]\n`;
    const r = validateMemory(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/invalid status/);
    expect(r.warnings.join()).toMatch(/\[read\] without a path/);
  });
  it("bundle requires index.md with okf_version and skips reserved names", () => {
    const files = { index: `---\nokf_version: "${OKF_VERSION}"\n---\n# idx\n`, global: stampMemory(BODY, { by: "human:t" }) };
    expect(validateBundle(files).ok).toBe(true);
    expect(validateBundle({ global: files.global }).ok).toBe(false);
    expect(Object.keys(validateBundle(files).results)).toEqual(["global"]);
  });
});

describe("paths", () => {
  it("recognises memory paths and names", () => {
    expect(isMemoryPath("/Users/t/UIG-AI/Projects/memory/global.md")).toBe(true);
    expect(isMemoryPath("~/TonyAI-Projects/memory/code.md")).toBe(true);
    expect(isMemoryPath("/Users/t/TonyAI-Projects/notes.md")).toBe(false);
    expect(memoryNameFromPath("C:\\Users\\t\\UIG-AI\\Projects\\memory\\ops.md")).toBe("ops");
  });
});
