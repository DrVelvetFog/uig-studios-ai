// FirstRun.jsx — what a fresh install sees instead of the example chips:
//   1. Ollama isn't reachable  → install link + retry
//   2. Ollama is up, no models → pick one sized to this machine and pull it
// Nothing here references the author's projects. Pure presentation; App.jsx owns state.
import { openUrl } from "@tauri-apps/plugin-opener";
import { modelFit, FIT_DOT } from "../modelFit.js";

// Curated starters (approximate download sizes; fit dots computed against installed RAM).
export const STARTER_MODELS = [
  { name: "qwen2.5-coder:7b",  bytes: 4.7e9, blurb: "code + tool calling, fast — the safe default" },
  { name: "llama3.2:3b",       bytes: 2.0e9, blurb: "small general chat, runs anywhere" },
  { name: "hermes3:8b",        bytes: 4.7e9, blurb: "agent / chat with tool calling" },
  { name: "qwen2.5-coder:14b", bytes: 9.0e9, blurb: "best quality on 16 GB+ (slower)" },
];
export const EMBED_MODEL = { name: "nomic-embed-text", bytes: 2.7e8, blurb: "optional — enables the knowledge-base search (RAG)" };

/** Which starters to show for this RAM: hide red-fit models unless nothing else fits. */
export function starterList(ramBytes) {
  const all = STARTER_MODELS.map(m => ({ ...m, fit: modelFit(m.bytes, ramBytes) }));
  const ok = all.filter(m => m.fit.level !== "red");
  return ok.length ? ok : all;
}

const OLLAMA_URL = "https://ollama.com/download";

export function FirstRun({ ollamaOk, models, ramBytes, pullingModel, pullStatus, onPull, onRetry, isDark }) {
  const card = { textAlign: "left", maxWidth: 520, width: "100%", padding: "16px 18px", borderRadius: 12,
                 background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                 border: `1px solid ${isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)"}`, fontSize: 13, lineHeight: 1.5 };
  const btn = { background: "rgba(124,92,191,0.12)", border: "1px solid rgba(124,92,191,0.4)", color: isDark ? "#c8b9ff" : "#4e35a0",
                cursor: "pointer", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontFamily: "inherit", fontWeight: 500 };
  const mono = { fontFamily: "'JetBrains Mono',monospace", fontSize: 11 };

  if (ollamaOk === false) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Ollama isn't running</div>
        <div style={{ opacity: 0.85, marginBottom: 10 }}>
          Models run locally through <span style={mono}>Ollama</span> (localhost:11434). Install it, launch it once, then retry.
          Nothing leaves this machine unless you add cloud keys later in Settings.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn} onClick={() => openUrl(OLLAMA_URL).catch(() => {})}>Get Ollama ↗</button>
          <button style={btn} onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }

  if (ollamaOk && (!models || models.length === 0)) {
    const list = starterList(ramBytes);
    const gb = ramBytes ? Math.round(ramBytes / 1e9) : null;
    return (
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Pull a model to get started</div>
        <div style={{ opacity: 0.85, marginBottom: 10 }}>
          Ollama is running but has no chat models yet.{gb ? ` This machine has ~${gb} GB RAM — ` : " "}
          {gb ? "dots show fit (🟢 comfortable · 🟡 tight · 🔴 will swap)." : "pick a small one first."}
        </div>
        {[...list, { ...EMBED_MODEL, fit: modelFit(EMBED_MODEL.bytes, ramBytes) }].map(m => {
          const st = pullStatus?.[m.name];
          const busy = pullingModel === m.name;
          return (
            <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"}` }}>
              <span>{FIT_DOT[m.fit.level]}</span>
              <span style={{ ...mono, minWidth: 150 }}>{m.name}</span>
              <span style={{ flex: 1, opacity: 0.75, fontSize: 12 }}>{m.blurb} · ~{(m.bytes / 1e9).toFixed(1)} GB</span>
              {st === "done" ? <span style={{ color: "#22c55e", fontSize: 12 }}>✓ pulled</span>
               : st?.startsWith?.("error") ? <span style={{ color: "#ef4444", fontSize: 11 }} title={st}>failed</span>
               : <button style={{ ...btn, opacity: busy || pullingModel ? 0.6 : 1 }} disabled={!!pullingModel} onClick={() => onPull(m.name)}>{busy ? "pulling…" : "Pull"}</button>}
            </div>
          );
        })}
        <div style={{ marginTop: 10, opacity: 0.7, fontSize: 11 }}>
          Or from a terminal: <span style={mono}>ollama pull qwen2.5-coder:7b</span> — then <button style={{ ...btn, padding: "2px 8px" }} onClick={onRetry}>refresh</button>.
        </div>
      </div>
    );
  }
  return null;
}
