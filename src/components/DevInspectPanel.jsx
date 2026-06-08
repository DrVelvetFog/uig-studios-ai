// ── Sui devInspect panel ─────────────────────────────────────────────────────
// Self-contained: BCS/PTB dry-run inspector. Extracted from App.jsx.
import { useState, useEffect } from "react";
import { fetch } from "@tauri-apps/plugin-http";

const INSPECT_CFG_KEY = "tonyai-inspect-cfg";
const DEFAULT_INSPECT_CFG = {
  rpcUrl: "https://fullnode.mainnet.sui.io:443",  // public full node — replace with your own RPC
  sender: "",  // set to your wallet address
};

function loadInspectCfg() {
  try { return JSON.parse(localStorage.getItem(INSPECT_CFG_KEY)) || DEFAULT_INSPECT_CFG; } catch { return DEFAULT_INSPECT_CFG; }
}
function saveInspectCfg(cfg) {
  try { localStorage.setItem(INSPECT_CFG_KEY, JSON.stringify(cfg)); } catch {}
}

function formatGas(gasUsed) {
  if (!gasUsed) return null;
  const comp = Number(gasUsed.computationCost);
  const stor = Number(gasUsed.storageCost);
  const reb  = Number(gasUsed.storageRebate);
  const net  = comp + stor - reb;
  return {
    computation: (comp/1e9).toFixed(6),
    storage:     (stor/1e9).toFixed(6),
    rebate:      (reb/1e9).toFixed(6),
    net:         (net/1e9).toFixed(6),
    netMist:     net,
  };
}

function tryDecodeReturnValue(bytes, type) {
  try {
    if (type === "u64" || type === "u128") {
      const view = new DataView(new Uint8Array(bytes).buffer);
      if (type === "u64" && bytes.length >= 8) {
        const lo = view.getUint32(0, true);
        const hi = view.getUint32(4, true);
        return String(BigInt(hi) * 0x100000000n + BigInt(lo));
      }
    }
    if (type === "bool" && bytes.length >= 1) return bytes[0] ? "true" : "false";
    if (type === "address" && bytes.length === 32) return "0x" + Array.from(bytes).map(b=>b.toString(16).padStart(2,"0")).join("");
    return "0x" + Array.from(bytes).map(b=>b.toString(16).padStart(2,"0")).join("");
  } catch { return bytes.toString(); }
}

export function DevInspectPanel({ accent, onClose }) {
  const [cfg, setCfg]         = useState(loadInspectCfg);
  const [bcsInput, setBcs]    = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [showHelper, setShowHelper] = useState(false);

  function updateCfg(k, v) {
    const next = { ...cfg, [k]: v };
    setCfg(next);
    saveInspectCfg(next);
  }

  async function run() {
    if (!bcsInput.trim()) return;
    setRunning(true); setResult(null); setError(null);
    try {
      const res = await fetch(cfg.rpcUrl, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          jsonrpc:"2.0", id:1,
          method:"sui_devInspectTransactionBlock",
          params:[cfg.sender, bcsInput.trim(), null, null],
        }),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      setResult(data.result);
    } catch(err) { setError(err.message); }
    setRunning(false);
  }

  const [suiPrice, setSuiPrice] = useState(null); // null = not yet fetched
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd")
      .then(r => r.json())
      .then(d => { if (d?.sui?.usd) setSuiPrice(d.sui.usd); })
      .catch(() => {}); // silently keep null on failure
  }, []);
  const SUI_PRICE = suiPrice ?? 0.35; // fallback to 0.35 if fetch hasn't resolved

  const gas    = result ? formatGas(result.effects?.gasUsed) : null;
  const status = result?.effects?.status?.status;
  const statusErr = result?.effects?.status?.error;
  const returns = result?.results || [];

  const helperSnippet = `// Add this after txb.setGasBudget() in flash-executor.ts (dev only)
const bytes = await txb.build({ client: suiClient });
console.log('[devInspect-bytes]', Buffer.from(bytes).toString('base64'));
// Then paste the logged base64 string into TonyAI's devInspect panel`;

  return (
    <div style={{ padding:"12px 18px 14px", borderBottom:"1px solid var(--tny-line)", background:"var(--tny-deep)", flexShrink:0 }}>
      {/* Header row */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
        <div style={{ width:7, height:7, borderRadius:"50%", background:accent, boxShadow:`0 0 6px ${accent}` }}/>
        <span style={{ fontSize:12, fontWeight:600, color:"var(--tny-tx3)", letterSpacing:"0.04em" }}>devInspect — simulate PTB against mainnet</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
          <button onClick={()=>setShowHelper(p=>!p)} style={{ background:"none", border:`1px solid ${showHelper?accent:"var(--tny-line2)"}`, color:showHelper?accent:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"3px 9px", fontSize:10, fontFamily:"inherit" }}>📋 How to get bytes</button>
          <button onClick={()=>setShowCfg(p=>!p)} style={{ background:"none", border:`1px solid ${showCfg?accent:"var(--tny-line2)"}`, color:showCfg?accent:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"3px 9px", fontSize:10, fontFamily:"inherit" }}>⚙ RPC config</button>
          <button onClick={onClose} style={{ background:"none", border:"1px solid var(--tny-line)", color:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"3px 9px", fontSize:10, fontFamily:"inherit" }}>✕</button>
        </div>
      </div>

      {/* Helper snippet */}
      {showHelper && (
        <div style={{ marginBottom:10 }}>
          <div style={{ fontSize:10, color:"var(--tny-tx4)", marginBottom:4 }}>Add this to your bot, restart, trigger a trade, copy the logged base64 string:</div>
          <pre style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", borderRadius:8, padding:"10px 12px", fontSize:11, color:"var(--tny-tx3)", fontFamily:"'JetBrains Mono',monospace", overflow:"auto", lineHeight:1.5, whiteSpace:"pre-wrap" }}>
            {helperSnippet}
          </pre>
        </div>
      )}

      {/* RPC config */}
      {showCfg && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
          <div>
            <label style={{ fontSize:10, color:"var(--tny-tx5)", textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:3 }}>RPC URL</label>
            <input value={cfg.rpcUrl} onChange={e=>updateCfg("rpcUrl",e.target.value)}
              style={{ width:"100%", background:"var(--tny-bg)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"'JetBrains Mono',monospace", outline:"none" }}/>
          </div>
          <div>
            <label style={{ fontSize:10, color:"var(--tny-tx5)", textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:3 }}>Sender Address</label>
            <input value={cfg.sender} onChange={e=>updateCfg("sender",e.target.value)}
              style={{ width:"100%", background:"var(--tny-bg)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"'JetBrains Mono',monospace", outline:"none" }}/>
          </div>
        </div>
      )}

      {/* BCS input + run */}
      <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
        <textarea value={bcsInput} onChange={e=>setBcs(e.target.value)}
          placeholder="Paste base64 PTB bytes here…"
          style={{ flex:1, height:52, background:"var(--tny-bg)", border:`1px solid ${bcsInput?"var(--tny-line3)":"var(--tny-line2)"}`, color:"var(--tny-tx3)", borderRadius:8, padding:"8px 10px", fontSize:11, fontFamily:"'JetBrains Mono',monospace", outline:"none", resize:"none", lineHeight:1.4 }}/>
        <button onClick={run} disabled={!bcsInput.trim()||running}
          style={{ padding:"0 16px", height:52, borderRadius:8, border:"none", background:bcsInput.trim()&&!running?accent:"var(--tny-line2)", color:bcsInput.trim()&&!running?"#fff":"var(--tny-tx4)", cursor:bcsInput.trim()&&!running?"pointer":"not-allowed", fontSize:12, fontWeight:600, fontFamily:"inherit", flexShrink:0, transition:"background 0.2s" }}>
          {running ? "⏳ Running…" : "▶ Run"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ marginTop:8, padding:"8px 12px", background:"var(--tny-error-bg)", border:"1px solid var(--tny-error-border)", borderRadius:8, color:"var(--tny-error-text)", fontSize:12 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop:10, display:"flex", flexDirection:"column", gap:8 }}>
          {/* Status */}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ padding:"3px 10px", borderRadius:6, fontSize:11, fontWeight:600, background:status==="success"?"var(--tny-surface)":"var(--tny-error-bg)", border:`1px solid ${status==="success"?"var(--tny-line2)":"var(--tny-error-border)"}`, color:status==="success"?"#16a34a":"var(--tny-error-text)" }}>
              {status==="success"?"✅ success":"❌ "+status}
            </div>
            {statusErr && <span style={{ fontSize:11, color:"var(--tny-error-text)" }}>{statusErr}</span>}
          </div>

          {/* Gas breakdown */}
          {gas && (
            <div style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", borderRadius:8, padding:"8px 12px" }}>
              <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>Gas Used</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
                {[
                  ["Computation", gas.computation, "var(--tny-tx3)"],
                  ["Storage",     gas.storage,     "var(--tny-tx3)"],
                  ["Rebate",      gas.rebate,       "#16a34a"],
                  ["Net SUI",     gas.net,          gas.netMist > 5_000_000 ? "var(--tny-error-text)" : "#d97706"],
                ].map(([label, val, color])=>(
                  <div key={label} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:10, color:"var(--tny-tx5)", marginBottom:2 }}>{label}</div>
                    <div style={{ fontSize:12, fontFamily:"'JetBrains Mono',monospace", color, fontWeight:600 }}>{val}</div>
                    <div style={{ fontSize:9, color:"var(--tny-tx5)" }}>SUI</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:6, fontSize:10, color:"var(--tny-tx5)", textAlign:"center" }}>
                ≈ ${(Number(gas.net) * SUI_PRICE).toFixed(5)} USD at ${suiPrice ? `$${SUI_PRICE.toFixed(3)}/SUI` : "$0.35/SUI (stale)"}
              </div>
            </div>
          )}

          {/* Return values */}
          {returns.length > 0 && (
            <div style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", borderRadius:8, padding:"8px 12px" }}>
              <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>Return Values ({returns.length} command{returns.length>1?"s":""})</div>
              {returns.map((r,ci)=> r.returnValues?.length > 0 && (
                <div key={ci} style={{ marginBottom:4 }}>
                  <span style={{ fontSize:10, color:"var(--tny-tx4)" }}>cmd[{ci}]: </span>
                  {r.returnValues.map(([bytes, type], ri)=>(
                    <span key={ri} style={{ fontSize:11, fontFamily:"'JetBrains Mono',monospace", color:accent, marginRight:8 }}>
                      {type}({tryDecodeReturnValue(bytes, type)})
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
