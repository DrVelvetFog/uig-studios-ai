import { describe, it, expect } from "vitest";
import { modelFit, memoryNeeded } from "./modelFit.js";

const GB = 1e9;
const RAM_16 = 16 * GB;

// These cases mirror real measurements on the 16GB M1 — if the constants
// drift, these tests catch the regression.
describe("modelFit — calibrated against measured behavior", () => {
  it("devstral:24b (14.3GB) is red on 16GB", () => {
    const f = modelFit(14.3 * GB, RAM_16);
    expect(f.level).toBe("red");
    expect(f.maxCtx).toBeNull();
  });

  it("qwen2.5-coder:14b (9GB) is green at 16K but not 32K on 16GB", () => {
    const f = modelFit(9.0 * GB, RAM_16);
    expect(f.level).toBe("green");
    expect(f.maxCtx).toBe(16384);
  });

  it("hermes3 (4.7GB) is green at full 32K on 16GB", () => {
    const f = modelFit(4.7 * GB, RAM_16);
    expect(f.level).toBe("green");
    expect(f.maxCtx).toBe(32768);
  });

  it("a 14B-class model becomes full-context green on a 32GB machine", () => {
    const f = modelFit(9.0 * GB, 32 * GB);
    expect(f.maxCtx).toBe(32768);
  });

  it("yellow when only 8K fits", () => {
    // 13GB RAM → 10GB usable; 8.2GB model: 8K needs ~9.6GB (fits), 16K needs ~10.9GB (doesn't)
    const f = modelFit(8.2 * GB, 13 * GB);
    expect(f.level).toBe("yellow");
    expect(f.maxCtx).toBe(8192);
  });

  it("unknown sizes fail open (assume fit)", () => {
    expect(modelFit(0, RAM_16).level).toBe("green");
    expect(modelFit(9 * GB, 0).level).toBe("green");
  });

  it("memoryNeeded scales linearly with context", () => {
    expect(memoryNeeded(9 * GB, 32768)).toBeCloseTo(9 * GB + 6 * GB, -9);
    expect(memoryNeeded(9 * GB, 16384)).toBeCloseTo(9 * GB + 3 * GB, -9);
  });
});
