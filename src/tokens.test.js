import { describe, it, expect, beforeEach } from "vitest";
import {
  estimateTokens, charsPerToken, observeTokenRatio,
  serializeTokenRatios, loadTokenRatios, resetTokenRatios,
  DEFAULT_CHARS_PER_TOKEN,
} from "./tokens.js";

beforeEach(() => resetTokenRatios());

describe("estimateTokens", () => {
  it("uses the conservative default before a model has been observed", () => {
    // 300 chars / (3.0 * 0.9 safety) = 111.1 -> 112
    expect(estimateTokens("unseen:model", "x".repeat(300))).toBe(112);
  });

  it("sums every part and tolerates null/undefined/empty", () => {
    const a = estimateTokens("m", "x".repeat(100), null, undefined, "", "x".repeat(100));
    const b = estimateTokens("m", "x".repeat(200));
    expect(a).toBe(b);
  });

  it("estimates high, never low, relative to the raw observed ratio", () => {
    observeTokenRatio("m", 3000, 1000);                 // ratio exactly 3.0
    // safety margin means the estimate exceeds the true 1000 tokens
    expect(estimateTokens("m", "x".repeat(3000))).toBeGreaterThan(1000);
  });

  it("beats the old flat chars/4 on tool-result-heavy content", () => {
    // Measured: 4000 chars of ops-history.jsonl was really 1707 tokens.
    const old = Math.ceil(4000 / 4);                    // 1000 — a 41% undercount
    observeTokenRatio("m", 4000, 1707);
    const now = estimateTokens("m", "x".repeat(4000));
    expect(old).toBeLessThan(1707);                     // the bug this replaces
    expect(now).toBeGreaterThanOrEqual(1707);           // the fix
  });
});

describe("observeTokenRatio", () => {
  it("adopts the first sample outright, then eases toward later ones", () => {
    expect(observeTokenRatio("m", 3000, 1000)).toBeCloseTo(3.0, 5);
    const second = observeTokenRatio("m", 4000, 2000);  // sample = 2.0
    expect(second).toBeGreaterThan(2.0);                // eased, not jumped
    expect(second).toBeLessThan(3.0);
  });

  it("reacts faster to denser content than to sparser — undercounting is the risk", () => {
    observeTokenRatio("denser", 3000, 1000);            // ratio 3.0
    observeTokenRatio("sparser", 3000, 1000);           // ratio 3.0
    const towardDenser  = observeTokenRatio("denser", 2400, 1000);   // sample 2.4, -0.6 away
    const towardSparser = observeTokenRatio("sparser", 3600, 1000);  // sample 3.6, +0.6 away
    expect(3.0 - towardDenser).toBeGreaterThan(towardSparser - 3.0);
  });

  it("clamps absurd samples instead of poisoning the average", () => {
    expect(observeTokenRatio("m", 100000, 1)).toBeCloseTo(5.0, 5);   // clamped high
    resetTokenRatios();
    expect(observeTokenRatio("m", 10, 1000)).toBeCloseTo(2.0, 5);    // clamped low
  });

  it("rejects unusable samples without touching the stored ratio", () => {
    observeTokenRatio("m", 3000, 1000);
    const before = charsPerToken("m");
    for (const bad of [[null, 3000, 1000], ["m", 0, 1000], ["m", 3000, 0], ["m", 3000, undefined]]) {
      expect(observeTokenRatio(...bad)).toBeNull();
    }
    expect(charsPerToken("m")).toBe(before);
  });

  it("tracks each model separately — tokenizers differ by family", () => {
    observeTokenRatio("qwen", 3000, 1000);
    observeTokenRatio("llama", 4500, 1000);
    expect(charsPerToken("qwen")).toBeLessThan(charsPerToken("llama"));
  });
});

describe("persistence", () => {
  it("round-trips through serialize/load", () => {
    observeTokenRatio("m", 3400, 1000);
    const saved = serializeTokenRatios();
    resetTokenRatios();
    expect(charsPerToken("m")).toBe(DEFAULT_CHARS_PER_TOKEN * 0.9);
    loadTokenRatios(saved);
    expect(charsPerToken("m")).toBeCloseTo(3.4 * 0.9, 5);
  });

  it("ignores malformed or out-of-range persisted values", () => {
    loadTokenRatios({ a: "3.2", b: 99, c: 0, d: null });
    loadTokenRatios(null);
    loadTokenRatios("nonsense");
    expect(serializeTokenRatios()).toEqual({});
  });
});
