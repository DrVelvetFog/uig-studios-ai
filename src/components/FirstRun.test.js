import { describe, it, expect } from "vitest";
import { starterList, STARTER_MODELS } from "./FirstRun.jsx";

describe("first-run starter list", () => {
  it("hides models that would swap on small machines, shows all when everything fits", () => {
    const small = starterList(8e9);
    expect(small.length).toBeGreaterThan(0);
    expect(small.every(m => m.fit.level !== "red")).toBe(true);
    expect(small.map(m => m.name)).not.toContain("qwen2.5-coder:14b");
    const big = starterList(64e9);
    expect(big.map(m => m.name)).toEqual(STARTER_MODELS.map(m => m.name));
  });
  it("never returns an empty list (falls back to all when nothing is green/yellow)", () => {
    expect(starterList(1e9).length).toBe(STARTER_MODELS.length);
  });
});
