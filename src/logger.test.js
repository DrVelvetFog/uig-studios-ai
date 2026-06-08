import { describe, it, expect } from "vitest";
import { formatLogLine } from "./logger.js";

describe("formatLogLine", () => {
  it("starts with an ISO timestamp and an upper-cased level", () => {
    const line = formatLogLine("error", "boom");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[ERROR\] boom$/);
  });
  it("defaults the level to INFO", () => {
    expect(formatLogLine(undefined, "hi")).toContain("[INFO]");
  });
  it("appends string meta after a pipe", () => {
    expect(formatLogLine("warn", "msg", "extra")).toContain("[WARN] msg | extra");
  });
  it("serializes object meta as JSON", () => {
    const line = formatLogLine("error", "tool failed", { tool: "run_command", code: 1 });
    expect(line).toContain('| {"tool":"run_command","code":1}');
  });
  it("omits empty meta", () => {
    expect(formatLogLine("info", "msg", {})).not.toContain("|");
    expect(formatLogLine("info", "msg", "")).not.toContain("|");
    expect(formatLogLine("info", "msg")).not.toContain("|");
  });
  it("handles null/undefined message safely", () => {
    expect(() => formatLogLine("info", null)).not.toThrow();
    expect(() => formatLogLine("info", undefined)).not.toThrow();
  });
});
