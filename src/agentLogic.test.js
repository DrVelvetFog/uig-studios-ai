import { describe, it, expect } from "vitest";
import {
  validateToolArgs,
  extractToolCallFromText,
  neededSearchButSkipped,
  evaluateStopCondition,
  enrichToolError,
  buildEditDiff,
  buildWriteDiff,
  approvalDiffFor,
  aggregateTelemetry,
  selectSessionsForCleanup,
} from "./agentLogic.js";

describe("selectSessionsForCleanup", () => {
  const DAY = 86_400_000;
  const now = 1_750_000_000_000;
  const sessions = [
    { id: now - 40 * DAY, title: "old" },
    { id: now - 10 * DAY, title: "mid" },
    { id: now - 1 * DAY,  title: "recent" },
    { id: now,            title: "active" },
  ];

  it("selects sessions older than N days, never the active one", () => {
    expect(selectSessionsForCleanup(sessions, { olderThanDays: 30, keepId: now, now }))
      .toEqual([now - 40 * DAY]);
    expect(selectSessionsForCleanup(sessions, { olderThanDays: 7, keepId: now, now }))
      .toEqual([now - 40 * DAY, now - 10 * DAY]);
  });

  it("olderThanDays 0 selects everything except the active session", () => {
    const ids = selectSessionsForCleanup(sessions, { olderThanDays: 0, keepId: now, now });
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(now);
  });

  it("protects the active session even when it is old", () => {
    const oldActive = now - 40 * DAY;
    expect(selectSessionsForCleanup(sessions, { olderThanDays: 30, keepId: oldActive, now }))
      .toEqual([]);
  });

  it("handles garbage input", () => {
    expect(selectSessionsForCleanup(null, { olderThanDays: 7 })).toEqual([]);
    expect(selectSessionsForCleanup(sessions, {})).toEqual([]);
  });
});

describe("aggregateTelemetry", () => {
  const LINES = [
    JSON.stringify({ model: "hermes3", outcome: "complete", loops: 4, stopRejections: 1, durationS: 30 }),
    JSON.stringify({ model: "hermes3", outcome: "answered", loops: 2, stopRejections: 0, durationS: 10 }),
    JSON.stringify({ model: "hermes3", outcome: "error",    loops: 1, stopRejections: 0, durationS: 5 }),
    JSON.stringify({ model: "llama3.2", outcome: "complete", loops: 6, stopRejections: 2, durationS: 60 }),
    "not json at all",
    "",
  ].join("\n");

  it("aggregates per model with rates and averages", () => {
    const stats = aggregateTelemetry(LINES);
    expect(stats).toHaveLength(2);
    const h = stats.find(s => s.model === "hermes3");
    expect(h.runs).toBe(3);
    expect(h.completionRate).toBe(33);
    expect(h.errorRate).toBe(33);
    expect(h.avgLoops).toBeCloseTo(2.3, 1);
    expect(h.avgDurationS).toBe(15);
    const l = stats.find(s => s.model === "llama3.2");
    expect(l.completionRate).toBe(100);
  });

  it("sorts by run count and survives garbage input", () => {
    const stats = aggregateTelemetry(LINES);
    expect(stats[0].model).toBe("hermes3");
    expect(aggregateTelemetry("")).toEqual([]);
    expect(aggregateTelemetry(null)).toEqual([]);
  });
});

describe("buildEditDiff / approvalDiffFor", () => {
  it("marks removed lines - and added lines +", () => {
    const d = buildEditDiff("foo\nbar\nbaz", "foo\nBAR\nbaz");
    expect(d).toEqual([
      { sign: " ", text: "foo" },
      { sign: "-", text: "bar" },
      { sign: "+", text: "BAR" },
      { sign: " ", text: "baz" },
    ]);
  });

  it("handles pure insertion", () => {
    const d = buildEditDiff("a\nc", "a\nb\nc");
    expect(d.filter(l => l.sign === "+").map(l => l.text)).toEqual(["b"]);
    expect(d.filter(l => l.sign === "-")).toHaveLength(0);
  });

  it("handles pure deletion", () => {
    const d = buildEditDiff("a\nb\nc", "a\nc");
    expect(d.filter(l => l.sign === "-").map(l => l.text)).toEqual(["b"]);
    expect(d.filter(l => l.sign === "+")).toHaveLength(0);
  });

  it("caps very long diffs with an omission marker", () => {
    const oldStr = Array.from({ length: 60 }, (_, i) => `old${i}`).join("\n");
    const newStr = Array.from({ length: 60 }, (_, i) => `new${i}`).join("\n");
    const d = buildEditDiff(oldStr, newStr);
    expect(d.length).toBeLessThanOrEqual(41);
    expect(d[d.length - 1].text).toMatch(/more line/);
  });

  it("buildWriteDiff renders content as all-added lines", () => {
    const d = buildWriteDiff("one\ntwo");
    expect(d).toEqual([{ sign: "+", text: "one" }, { sign: "+", text: "two" }]);
  });

  it("approvalDiffFor routes by tool name", () => {
    expect(approvalDiffFor("edit_file", { old_string: "a", new_string: "b" })
      .some(l => l.sign === "-")).toBe(true);
    expect(approvalDiffFor("write_file", { content: "x" })).toEqual([{ sign: "+", text: "x" }]);
    expect(approvalDiffFor("run_command", { command: "ls" })).toBeNull();
  });
});

describe("evaluateStopCondition — edit_file counts as code change", () => {
  it("blocks stop when a code file was edited but never run", () => {
    const r = evaluateStopCondition([
      { name: "edit_file", args: { path: "/tmp/app.py" }, status: "done", result: "Replaced 1 occurrence" },
    ]);
    expect(r.canStop).toBe(false);
  });

  it("allows stop when edited code file ran with exit 0", () => {
    const r = evaluateStopCondition([
      { name: "edit_file",   args: { path: "/tmp/app.py" }, status: "done", result: "Replaced 1 occurrence" },
      { name: "run_command", args: { command: "python3 /tmp/app.py" }, status: "done", result: "ok\n[exit 0]" },
    ]);
    expect(r.canStop).toBe(true);
  });

  it("ignores edit_file on non-code files", () => {
    const r = evaluateStopCondition([
      { name: "edit_file", args: { path: "/tmp/notes.md" }, status: "done", result: "Replaced 1 occurrence" },
    ]);
    expect(r.canStop).toBe(true);
  });
});

const TOOLS = [
  { function: { name: "read_file",  parameters: { required: ["path"], properties: { path: { description: "file path" } } } } },
  { function: { name: "web_search", parameters: { required: ["query"], properties: { query: { description: "search query" } } } } },
  { function: { name: "list_dir",   parameters: { required: ["path"], properties: {} } } },
];

describe("validateToolArgs", () => {
  it("accepts a call with all required args", () => {
    expect(validateToolArgs("read_file", { path: "/x" }, TOOLS)).toEqual({ valid: true });
  });
  it("rejects an unknown tool and lists available ones", () => {
    const r = validateToolArgs("frobnicate", {}, TOOLS);
    expect(r.valid).toBe(false);
    expect(r.error).toContain("does not exist");
    expect(r.error).toContain("read_file");
  });
  it("rejects missing required args with a helpful hint", () => {
    const r = validateToolArgs("read_file", {}, TOOLS);
    expect(r.valid).toBe(false);
    expect(r.error).toContain("path");
    expect(r.error).toContain("file path");
  });
  it("treats empty-string / null args as missing", () => {
    expect(validateToolArgs("web_search", { query: "" }, TOOLS).valid).toBe(false);
    expect(validateToolArgs("web_search", { query: null }, TOOLS).valid).toBe(false);
  });
});

describe("extractToolCallFromText", () => {
  it("parses a bare JSON tool call", () => {
    const r = extractToolCallFromText('{"tool":"read_file","args":{"path":"/a"}}');
    expect(r[0].function.name).toBe("read_file");
    expect(r[0].function.arguments).toEqual({ path: "/a" });
  });
  it("parses JSON inside a markdown fence", () => {
    const r = extractToolCallFromText('```json\n{"name":"web_search","arguments":{"query":"sui"}}\n```');
    expect(r[0].function.name).toBe("web_search");
    expect(r[0].function.arguments.query).toBe("sui");
  });
  it("parses JSON embedded in prose", () => {
    const r = extractToolCallFromText('Sure, let me search. {"tool":"web_search","args":{"query":"x"}} done');
    expect(r[0].function.name).toBe("web_search");
  });
  it("accepts alternate key conventions (function/parameters, action/input)", () => {
    expect(extractToolCallFromText('{"function":"list_dir","parameters":{"path":"/"}}')[0].function.name).toBe("list_dir");
    expect(extractToolCallFromText('{"action":"list_dir","input":{"path":"/"}}')[0].function.name).toBe("list_dir");
  });
  it("handles nested braces and quoted strings in args", () => {
    const r = extractToolCallFromText('{"tool":"write_file","args":{"content":"return {\\"x\\":1}"}}');
    expect(r[0].function.name).toBe("write_file");
    expect(r[0].function.arguments.content).toBe('return {"x":1}');
  });
  it("strips <think> blocks before parsing", () => {
    const r = extractToolCallFromText('<think>I should read it</think>{"tool":"read_file","args":{"path":"/a"}}');
    expect(r[0].function.name).toBe("read_file");
  });
  it("returns null when there is no tool call", () => {
    expect(extractToolCallFromText("Just a plain answer, no JSON here.")).toBeNull();
    expect(extractToolCallFromText('{"foo":"bar"}')).toBeNull();
  });
});

describe("neededSearchButSkipped", () => {
  it("flags time-sensitive prompts that skipped search", () => {
    expect(neededSearchButSkipped("What is the latest SUI price?", [])).toBe(true);
    expect(neededSearchButSkipped("Any news today?", [{ name: "read_file" }])).toBe(true);
  });
  it("passes when search was used", () => {
    expect(neededSearchButSkipped("latest price?", [{ name: "web_search" }])).toBe(false);
    expect(neededSearchButSkipped("recent news", [{ name: "deep_search" }])).toBe(false);
    expect(neededSearchButSkipped("current status", [{ name: "fetch_url" }])).toBe(false);
  });
  it("passes for prompts that don't need current info", () => {
    expect(neededSearchButSkipped("Explain how a hashmap works", [])).toBe(false);
  });
});

describe("evaluateStopCondition", () => {
  it("blocks stopping when code was written but never run", () => {
    const r = evaluateStopCondition([{ name: "write_file", args: { path: "main.py" }, status: "done" }]);
    expect(r.canStop).toBe(false);
    expect(r.reason).toMatch(/run/i);
  });
  it("allows stopping when code ran successfully ([exit 0])", () => {
    const r = evaluateStopCondition([
      { name: "write_file", args: { path: "main.py" }, status: "done" },
      { name: "run_command", args: {}, status: "done", result: "ok\n[exit 0]" },
    ]);
    expect(r.canStop).toBe(true);
  });
  it("blocks stopping when the run failed (non-zero exit)", () => {
    const r = evaluateStopCondition([
      { name: "write_file", args: { path: "main.py" }, status: "done" },
      { name: "run_command", args: {}, status: "done", result: "Traceback...\n[exit 1]" },
    ]);
    expect(r.canStop).toBe(false);
    expect(r.reason).toMatch(/exit 0/);
  });
  it("counts a coder subagent as having written code", () => {
    const r = evaluateStopCondition([{ name: "spawn_subagent", args: { role: "coder" }, status: "done" }]);
    expect(r.canStop).toBe(false);
  });
  it("allows stopping for non-code tasks", () => {
    expect(evaluateStopCondition([{ name: "web_search", args: {}, status: "done" }]).canStop).toBe(true);
    expect(evaluateStopCondition([]).canStop).toBe(true);
  });
  it("considers run_command inside subagent sub-steps", () => {
    const r = evaluateStopCondition([
      { name: "write_file", args: { path: "a.py" }, status: "done" },
      { name: "spawn_subagent", args: { role: "verifier" }, status: "done",
        subSteps: [{ name: "run_command", status: "done", result: "[exit 0]" }] },
    ]);
    expect(r.canStop).toBe(true);
  });
});

describe("enrichToolError", () => {
  it("appends a tool-specific hint", () => {
    expect(enrichToolError("read_file", "ENOENT")).toContain("Hint:");
    expect(enrichToolError("read_file", "ENOENT")).toContain("list_dir");
  });
  it("falls back to a generic hint for unknown tools", () => {
    expect(enrichToolError("mystery_tool", "boom")).toContain("Adjust the arguments");
  });
});
