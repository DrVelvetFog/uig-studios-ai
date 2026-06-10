// ── Hybrid retrieval (vector + keyword, fused with RRF) ──────────────────────
// Pure module — no React/Tauri imports, fully unit-testable.
//
// Cosine-only retrieval fuzzes over exact identifiers (package addresses,
// function names, hex constants) that matter a lot in a developer knowledge
// base. Keyword scoring catches those; Reciprocal Rank Fusion combines the two
// rankings without any score-normalization headaches and degrades gracefully
// when either signal is weak.

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Split a query into searchable terms. Underscores and digits stay inside
// tokens so identifiers like flash_loan_with_ctx_v2 and 0x81c4 survive whole.
export function tokenizeQuery(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(t => t.length >= 3)
  )];
}

// TF-IDF-ish keyword score per chunk. Substring matching (not word-boundary)
// so "0x81c4" matches inside the full address literal.
export function keywordScores(chunks, queryTerms) {
  const n = chunks.length;
  if (n === 0 || queryTerms.length === 0) return new Map();

  const lowered = chunks.map(c => String(c.text || "").toLowerCase());

  const scores = new Map(); // chunk index → score
  for (const term of queryTerms) {
    let df = 0;
    for (const text of lowered) if (text.includes(term)) df++;
    if (df === 0) continue;
    const idf = Math.log(1 + n / df);
    for (let i = 0; i < n; i++) {
      let tf = 0, pos = -1;
      while (tf < 5 && (pos = lowered[i].indexOf(term, pos + 1)) !== -1) tf++;
      if (tf > 0) scores.set(i, (scores.get(i) || 0) + tf * idf);
    }
  }
  return scores;
}

// Reciprocal Rank Fusion of the vector ranking and the keyword ranking.
// fused(chunk) = Σ over rankings 1/(K + rank); chunks missing from a ranking
// simply contribute nothing from it. K=60 is the standard RRF constant.
const RRF_K = 60;

export function hybridRetrieve(chunks, queryEmbedding, queryText, topK = 4) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const fused = new Map(); // index → fused score
  const addRanking = (orderedIndices) => {
    orderedIndices.forEach((idx, rank) => {
      fused.set(idx, (fused.get(idx) || 0) + 1 / (RRF_K + rank));
    });
  };

  // Vector ranking (skipped cleanly if no embedding available)
  if (queryEmbedding) {
    const byVector = chunks
      .map((c, i) => ({ i, sim: c.embedding ? cosineSim(queryEmbedding, c.embedding) : -1 }))
      .filter(x => x.sim >= 0)
      .sort((a, b) => b.sim - a.sim)
      .map(x => x.i);
    addRanking(byVector);
  }

  // Keyword ranking (only chunks that matched at least one term)
  const kw = keywordScores(chunks, tokenizeQuery(queryText));
  const byKeyword = [...kw.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
  addRanking(byKeyword);

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([i, score]) => ({ ...chunks[i], score }));
}
