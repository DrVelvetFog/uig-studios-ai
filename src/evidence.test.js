import { describe, it, expect } from "vitest";
import { tierForTool, stepEvidence, evidenceSummary, completionTier, evidenceLine, buildTurnStatement, fnv1a } from "./evidence.js";

const steps = [
  { name: "read_file", args: { path: "/p/a.js" }, status: "done", result: "code" },
  { name: "write_file", args: { path: "/p/a.js" }, status: "done", result: "ok" },
  { name: "run_command", args: { command: "npm test" }, status: "done", result: "42 passed\n[exit 0]", rv: { root: "/p", seq: 9 } },
  { name: "web_search", args: { query: "x" }, status: "done", result: "..." },
  { name: "spawn_subagent", args: { role: "coder" }, status: "done", result: "done", subSteps: [
    { name: "run_command", args: { command: "node x" }, status: "done", result: "boom\n[exit 1]" },
    { name: "mcp__gh__get_issue", args: {}, status: "done", result: "{}" },
  ]},
];

describe("tiers", () => {
  it("maps tools by kind; writes are actions; mcp is told", () => {
    expect(tierForTool("run_command")).toBe("ran");
    expect(tierForTool("fetch_url")).toBe("read");
    expect(tierForTool("mcp__x__y")).toBe("told");
    expect(tierForTool("write_file")).toBeNull();
  });
  it("step evidence carries refs, rv journal ref, exit ok", () => {
    expect(stepEvidence(steps[0])).toMatchObject({ tier: "read", kind: "artifact", uri: "file:/p/a.js", ok: true });
    expect(stepEvidence(steps[2])).toMatchObject({ tier: "ran", ref: "rv:/p#9", exit: 0, ok: true });
    expect(stepEvidence(steps[4].subSteps[0])).toMatchObject({ tier: "ran", ref: "tool:run_command", exit: 1, ok: false });
    expect(stepEvidence(steps[1]).tier).toBeNull();
  });
  it("summary + completion tier + line, including sub-steps", () => {
    expect(evidenceSummary(steps)).toEqual({ ran: 2, read: 1, told: 3, action: 1, failed: 1 });
    expect(completionTier(steps)).toBe("ran");
    expect(completionTier(steps.filter(s => s.name !== "run_command" && s.name !== "spawn_subagent"))).toBe("read");
    expect(completionTier([steps[3]])).toBe("told");
    expect(completionTier([steps[1]])).toBe("recalled");
    expect(completionTier([steps[4].subSteps[0]])).toBe("recalled");   // failed run doesn't count
    expect(evidenceLine(steps)).toBe("ran 2 · read 1 · told 3 · 1 failed");
    expect(evidenceLine([])).toBe("no evidence (recalled)");
  });
});

describe("statement", () => {
  it("builds an in-toto Statement with the ev predicate; ran claim cites only actions", async () => {
    const st = await buildTurnStatement({ turnId: "t1", model: "qwen", mode: "agent", finalText: "Done. Tests pass.", steps, at: "2026-08-17T15:00:00Z" });
    expect(st._type).toBe("https://in-toto.io/Statement/v1");
    expect(st.subject[0].name).toBe("turn:t1");
    expect(Object.keys(st.subject[0].digest)[0]).toMatch(/^(sha256|fnv1a)$/);
    const c = st.predicate.claims[0];
    expect(c.tier).toBe("ran");
    expect(c.evidence.every(e => e.kind === "action")).toBe(true);
    expect(c.evidence.map(e => e.ref)).toEqual(["rv:/p#9"]);   // failed sub-run excluded
    expect(st.predicate.ledger).toHaveLength(7);
    expect(st.predicate.producer).toMatchObject({ tool: "uig-studios-ai", model: "qwen" });
  });
  it("recalled claim has no evidence", async () => {
    const st = await buildTurnStatement({ turnId: "t2", model: "m", mode: "chat", finalText: "I think so", steps: [] });
    expect(st.predicate.claims[0]).toMatchObject({ tier: "recalled", evidence: [] });
  });
  it("fnv1a is stable", () => { expect(fnv1a("abc")).toBe("1a47e90b"); });
});
