import { describe, it, expect } from "vitest";
import { cosineSim, tokenizeQuery, keywordScores, hybridRetrieve } from "./retrieval.js";

const CHUNKS = [
  { text: "The flash loan executor calls flash_loan_with_ctx_v2 on the NAVI pool.", embedding: [1, 0] },
  { text: "General notes about cooking pasta and tomato sauce.",                  embedding: [0.9, 0.1] },
  { text: "BLUEFIN_MIN_SQRT is 4295048017 — off by one causes MoveAbort 1009.",   embedding: [0, 1] },
];

describe("tokenizeQuery", () => {
  it("keeps identifiers and hex-ish tokens whole", () => {
    const t = tokenizeQuery("Why does flash_loan_with_ctx_v2 fail at 0x81c4?");
    expect(t).toContain("flash_loan_with_ctx_v2");
    expect(t).toContain("0x81c4");
    expect(t).not.toContain("at"); // short words dropped
  });
});

describe("keywordScores", () => {
  it("scores chunks containing query terms, zero otherwise", () => {
    const s = keywordScores(CHUNKS, ["flash_loan_with_ctx_v2"]);
    expect(s.get(0)).toBeGreaterThan(0);
    expect(s.has(1)).toBe(false);
  });

  it("rarer terms score higher than common ones", () => {
    const chunks = [
      { text: "alpha beta" }, { text: "alpha gamma" }, { text: "alpha delta" },
    ];
    const s = keywordScores(chunks, ["alpha", "delta"]);
    // delta appears in 1/3 chunks → higher idf than alpha (3/3)
    expect(s.get(2)).toBeGreaterThan(s.get(0));
  });
});

describe("hybridRetrieve", () => {
  it("exact identifier match wins even when embeddings disagree", () => {
    // Query embedding points at the pasta chunk, but the identifier
    // only appears in chunk 0 — keyword rank must pull chunk 0 to the top.
    const out = hybridRetrieve(CHUNKS, [0.9, 0.1], "flash_loan_with_ctx_v2 failing", 2);
    expect(out[0].text).toContain("flash_loan_with_ctx_v2");
  });

  it("falls back to pure vector ranking when no keywords match", () => {
    const out = hybridRetrieve(CHUNKS, [0, 1], "zzz qqq xxx", 1);
    expect(out[0].text).toContain("BLUEFIN_MIN_SQRT");
  });

  it("works keyword-only when no query embedding is provided", () => {
    const out = hybridRetrieve(CHUNKS, null, "MoveAbort 1009", 1);
    expect(out[0].text).toContain("MoveAbort");
  });

  it("attaches a score and respects topK; survives garbage", () => {
    const out = hybridRetrieve(CHUNKS, [1, 0], "flash loan", 2);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeGreaterThan(0);
    expect(hybridRetrieve([], [1, 0], "x", 3)).toEqual([]);
    expect(hybridRetrieve(null, [1, 0], "x", 3)).toEqual([]);
  });

  it("cosineSim handles zero vectors", () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});
