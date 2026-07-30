#!/usr/bin/env node
/**
 * TonyAI RAG indexer — builds a semantic search index over a source tree.
 * Point SOURCE_DIRS at whatever codebase sui/auto mode should be able to search.
 * Run: node scripts/build-rag-index.mjs
 * Output: ~/.tonyai/rag-index.json
 */

import fs from "fs";
import path from "path";
import os from "os";

const OLLAMA_URL    = "http://localhost:11434";
const EMBED_MODEL   = "nomic-embed-text";
const SOURCE_DIRS   = [
  "/Users/tonyjagodka/tonyai/src",
];
const SOURCE_EXTS   = new Set([".ts", ".js", ".rs", ".py", ".move"]);
const CHUNK_SIZE    = 1200;   // chars per chunk
const CHUNK_OVERLAP = 200;    // overlap between chunks
const OUTPUT_PATH   = path.join(os.homedir(), ".tonyai", "rag-index.json");

// ── Chunker ──────────────────────────────────────────────────────────────────
function chunkText(text, filename) {
  const lines = text.split("\n");
  const chunks = [];
  let buf = "";
  let startLine = 1;
  let lineNum = 1;

  for (const line of lines) {
    buf += line + "\n";
    if (buf.length >= CHUNK_SIZE) {
      chunks.push({ file: filename, startLine, endLine: lineNum, text: buf.trim() });
      // keep overlap
      const overlapLines = buf.split("\n").slice(-Math.ceil(CHUNK_OVERLAP / 40));
      buf = overlapLines.join("\n") + "\n";
      startLine = lineNum - overlapLines.length + 1;
    }
    lineNum++;
  }
  if (buf.trim().length > 80) {
    chunks.push({ file: filename, startLine, endLine: lineNum - 1, text: buf.trim() });
  }
  return chunks;
}

// ── Embedding ─────────────────────────────────────────────────────────────────
async function embed(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = await res.json();
  return data.embeddings; // array of float arrays
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔷 TonyAI RAG Indexer");
  console.log(`   Model:  ${EMBED_MODEL}`);
  console.log(`   Output: ${OUTPUT_PATH}`);
  console.log();

  // Verify Ollama + model
  try {
    await embed(["test"]);
  } catch (e) {
    console.error(`❌ Cannot reach Ollama or ${EMBED_MODEL} not pulled.`);
    console.error(`   Run: ollama pull ${EMBED_MODEL}`);
    process.exit(1);
  }

  // Collect all source files
  const allChunks = [];
  for (const dir of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) { console.warn(`  ⚠ Skipping (not found): ${dir}`); continue; }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTS.has(ext)) continue;
      const filePath = path.join(dir, entry.name);
      const text = fs.readFileSync(filePath, "utf8");
      const relName = path.relative(path.dirname(dir), filePath);
      const chunks = chunkText(text, relName);
      allChunks.push(...chunks);
      console.log(`  📄 ${relName} — ${chunks.length} chunks`);
    }
  }

  console.log(`\n  Total chunks: ${allChunks.length}`);
  console.log(`  Embedding with ${EMBED_MODEL}...\n`);

  // Embed in batches of 16
  const BATCH = 16;
  const embeddedChunks = [];
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    const texts = batch.map(c => `File: ${c.file}\n\n${c.text}`);
    const embeddings = await embed(texts);
    for (let j = 0; j < batch.length; j++) {
      embeddedChunks.push({
        id: i + j,
        file: batch[j].file,
        startLine: batch[j].startLine,
        endLine: batch[j].endLine,
        text: batch[j].text,
        embedding: embeddings[j].map(v => Math.round(v * 10000) / 10000), // 4dp saves ~60% size
      });
    }
    const pct = Math.min(100, Math.round(((i + BATCH) / allChunks.length) * 100));
    process.stdout.write(`  Progress: ${pct}% (${Math.min(i + BATCH, allChunks.length)}/${allChunks.length})\r`);
  }
  console.log("\n");

  // Write index
  const index = {
    version: 1,
    model: EMBED_MODEL,
    indexed_at: new Date().toISOString(),
    sources: SOURCE_DIRS,
    chunk_count: embeddedChunks.length,
    chunks: embeddedChunks,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index));

  const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`✅ Index built: ${embeddedChunks.length} chunks, ${sizeMB} MB`);
  console.log(`   Saved to: ${OUTPUT_PATH}`);
  console.log(`\n   Restart TonyAI — RAG will auto-load in Arb Bot mode.`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
