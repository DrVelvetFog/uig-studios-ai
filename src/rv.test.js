import { describe, it, expect } from "vitest";
import { leadingCd, rvScope, rvWrapCommand, parseRvReport, stripRvReport, rvUndoCommand } from "./rv.js";

describe("scope", () => {
  it("finds a leading cd (bare, quoted, ~) and ignores non-leading", () => {
    expect(leadingCd("cd /a/b && npm test")).toBe("/a/b");
    expect(leadingCd('cd "/a b/c"; ls')).toBe("/a b/c");
    expect(leadingCd("cd ~/proj && make")).toBe("~/proj");
    expect(leadingCd("cd /x")).toBe("/x");
    expect(leadingCd("npm test && cd /x")).toBeNull();
    expect(leadingCd("echo cd /x")).toBeNull();
  });
  it("falls back to last tool dir, else null", () => {
    expect(rvScope("ls", "/proj")).toBe("/proj");
    expect(rvScope("cd /a && ls", "/proj")).toBe("/a");
    expect(rvScope("ls", null)).toBeNull();
  });
});

describe("wrap / parse", () => {
  it("wraps with quoting the shell can execute, keeps ~ expandable", () => {
    const w = rvWrapCommand(`echo "it's" > f.txt`, "/p/q r", { actor: "tonyai/qwen" });
    expect(w).toBe(`cd '/p/q r' && ~/reversible/rv wrap --actor 'tonyai/qwen' -- 'echo "it'\\''s" > f.txt'`);
    expect(rvWrapCommand("ls", "~/proj")).toMatch(/^cd ~\/proj && /);
  });
  it("parses and strips the report line", () => {
    const out = "hello\nSTDERR: rv: #7 changed root=/p/q\n[exit 0]";
    expect(parseRvReport(out)).toEqual({ seq: 7, changed: true, root: "/p/q" });
    expect(stripRvReport(out)).toBe("hello\n[exit 0]");
    expect(parseRvReport("plain")).toBeNull();
    expect(parseRvReport("STDERR: rv: #2 no-change root=/x").changed).toBe(false);
  });
  it("builds undo command", () => {
    expect(rvUndoCommand({ seq: 3, root: "/p" })).toBe(`cd '/p' && ~/reversible/rv undo 3`);
    expect(rvUndoCommand({ seq: 3, root: "/p" }, { dryRun: true })).toMatch(/--dry-run$/);
  });
});
