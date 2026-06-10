import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isCloudModel, cloudProvider, cloudModelId, cloudDisplayName } from "../cloud.js";

// ── Blind model comparison ────────────────────────────────────────────────────
// One prompt, two models, side-by-side streaming with names hidden as A/B.
// Sides are shuffled per run; the user votes before names are revealed; votes
// log to ~/.tonyai/compare-votes.jsonl for later win-rate analysis.
//
// Memory nuance: two LOCAL models loaded simultaneously can exceed unified
// memory on smaller machines, so local-vs-local pairs run sequentially;
// any pair involving a cloud model streams concurrently.

async function streamOne(modelId, prompt, onDelta, registerEventId) {
  const eventId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  registerEventId(eventId);
  let text = "";
  const unlisten = await listen(`ollama-chunk-${eventId}`, (ev) => {
    for (const line of (ev.payload || "").split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.message?.content) { text += j.message.content; onDelta(text); }
      } catch {}
    }
  });
  try {
    const messages = [{ role: "user", content: prompt }];
    if (isCloudModel(modelId)) {
      const body = {
        model: cloudModelId(modelId), messages, stream: true, temperature: 0.7,
        ...(cloudProvider(modelId) === "openrouter"
          ? { usage: { include: true } }
          : { stream_options: { include_usage: true } }),
      };
      await invoke("cloud_chat", { provider: cloudProvider(modelId), body: JSON.stringify(body), eventId });
    } else {
      await invoke("ollama_chat", {
        body: JSON.stringify({ model: modelId, messages, stream: true, options: { temperature: 0.7, num_ctx: 8192 } }),
        eventId,
      });
    }
  } finally {
    unlisten();
  }
  return text;
}

const displayName = (m) => isCloudModel(m) ? `☁ ${cloudDisplayName(m)}` : m;

export function ComparePanel({ localModels, cloudModels, accent, onClose }) {
  const allModels = [...localModels, ...cloudModels];
  const [m1, setM1] = useState(allModels[0] || "");
  const [m2, setM2] = useState(allModels[1] || allModels[0] || "");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState("idle");        // idle | running | vote | revealed
  const [outA, setOutA] = useState("");
  const [outB, setOutB] = useState("");
  const [sides, setSides] = useState(null);          // { A: modelId, B: modelId }
  const [verdict, setVerdict] = useState(null);      // "A" | "B" | "tie"
  const [error, setError] = useState("");
  const activeIds = useRef([]);

  async function run() {
    if (!prompt.trim() || !m1 || !m2 || phase === "running") return;
    setPhase("running"); setOutA(""); setOutB(""); setVerdict(null); setError("");
    activeIds.current = [];

    // Shuffle which model sits on which side — that's the "blind" part
    const flip = Math.random() < 0.5;
    const sideMap = { A: flip ? m2 : m1, B: flip ? m1 : m2 };
    setSides(sideMap);

    const reg = (id) => activeIds.current.push(id);
    const runA = () => streamOne(sideMap.A, prompt, setOutA, reg);
    const runB = () => streamOne(sideMap.B, prompt, setOutB, reg);
    const bothLocal = !isCloudModel(sideMap.A) && !isCloudModel(sideMap.B);

    try {
      if (bothLocal) { await runA(); await runB(); }   // sequential — don't double-load RAM
      else           { await Promise.all([runA(), runB()]); }
      setPhase("vote");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  function stop() {
    for (const id of activeIds.current) invoke("ollama_abort", { eventId: id }).catch(() => {});
  }

  async function vote(v) {
    setVerdict(v);
    setPhase("revealed");
    try {
      await invoke("append_compare_vote", {
        line: JSON.stringify({
          ts: new Date().toISOString(),
          modelA: sides.A, modelB: sides.B,
          winner: v === "tie" ? "tie" : sides[v],
          prompt: prompt.slice(0, 200),
        }),
      });
    } catch {}
  }

  const col = (label, text, modelId) => (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--tny-tx3)", fontFamily: "'JetBrains Mono',monospace" }}>
        {phase === "revealed" ? `${label} = ${displayName(modelId)}` : `Model ${label}`}
        {phase === "revealed" && verdict !== "tie" && verdict === label && <span style={{ color: "#22c55e" }}> 🏆</span>}
      </div>
      <div style={{ background: "var(--tny-code)", border: "1px solid var(--tny-line)", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "var(--tny-tx2)", whiteSpace: "pre-wrap", overflowY: "auto", minHeight: 80, maxHeight: 240, lineHeight: 1.5 }}>
        {text || (phase === "running" ? "…" : "")}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "12px 20px 14px", borderTop: "1px solid var(--tny-line)", background: "var(--tny-sidebar)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 10, maxHeight: 460, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: "var(--tny-tx5)", letterSpacing: "0.08em", textTransform: "uppercase", flex: 1 }}>
          ⚖️ Blind compare — names hidden until you vote
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--tny-tx4)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</button>
      </div>

      {/* Model pickers + prompt */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {[["1", m1, setM1], ["2", m2, setM2]].map(([n, val, set]) => (
          <select key={n} value={val} onChange={e => set(e.target.value)} disabled={phase === "running"}
            style={{ background: "var(--tny-code)", border: "1px solid var(--tny-line)", color: "var(--tny-tx3)", borderRadius: 6, padding: "5px 8px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", outline: "none", maxWidth: 220 }}>
            {localModels.map(m => <option key={m} value={m}>{m}</option>)}
            {cloudModels.length > 0 && cloudModels.map(m => <option key={m} value={m}>☁ {cloudDisplayName(m)}</option>)}
          </select>
        ))}
        <input value={prompt} onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") run(); }}
          placeholder="One prompt, two models — who answers it better?"
          disabled={phase === "running"}
          style={{ flex: 1, minWidth: 220, background: "var(--tny-surface)", border: "1px solid var(--tny-line2)", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "var(--tny-tx1)", fontFamily: "inherit", outline: "none" }}/>
        {phase === "running"
          ? <button onClick={stop} style={{ background: "#ef4444", border: "none", color: "#fff", cursor: "pointer", borderRadius: 6, padding: "6px 14px", fontSize: 11, fontFamily: "inherit" }}>■ Stop</button>
          : <button onClick={run} disabled={!prompt.trim() || m1 === m2}
              title={m1 === m2 ? "Pick two different models" : ""}
              style={{ background: `${accent}18`, border: `1px solid ${accent}66`, color: accent, cursor: "pointer", borderRadius: 6, padding: "6px 14px", fontSize: 11, fontFamily: "inherit", fontWeight: 600 }}>
              ▶ Run
            </button>}
      </div>

      {error && <div style={{ fontSize: 11, color: "#ef4444", fontFamily: "'JetBrains Mono',monospace" }}>⚠ {error}</div>}

      {/* Responses */}
      {(outA || outB || phase === "running") && (
        <div style={{ display: "flex", gap: 12 }}>
          {col("A", outA, sides?.A)}
          {col("B", outB, sides?.B)}
        </div>
      )}

      {/* Vote */}
      {phase === "vote" && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={() => vote("A")} style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)", color: "#22c55e", cursor: "pointer", borderRadius: 6, padding: "6px 18px", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>◀ A is better</button>
          <button onClick={() => vote("tie")} style={{ background: "none", border: "1px solid var(--tny-line2)", color: "var(--tny-tx4)", cursor: "pointer", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontFamily: "inherit" }}>Tie</button>
          <button onClick={() => vote("B")} style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)", color: "#22c55e", cursor: "pointer", borderRadius: 6, padding: "6px 18px", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>B is better ▶</button>
        </div>
      )}
      {phase === "revealed" && (
        <div style={{ fontSize: 11, color: "var(--tny-tx4)", textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }}>
          Vote saved to ~/.tonyai/compare-votes.jsonl — run another round with a different prompt.
        </div>
      )}
    </div>
  );
}
