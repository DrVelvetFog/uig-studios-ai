// ── Ops console panel ─────────────────────────────────────────────────────────
// Portfolio status cards from ~/.tonyai/ops-state.json, written by the
// background monitor's ops checks (scripts/ops.mjs) every 5 minutes.
// Pure presentational — "Fix" prefills a prompt via onAsk so any mutating
// command still flows through the normal agent approval path.

const STATUS_COLOR = { up: "#22c068", down: "#ef4444", unknown: "#f97316" };
// Card group order: ops.json may set "projectOrder"; otherwise groups appear in first-seen order.

function age(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fixPrompt(c) {
  return `[Ops: ${c.project} — ${c.label} is ${(c.status || "?").toUpperCase()}]\n` +
    `Detail: ${c.detail}\n` +
    `Diagnose this and fix it if you can. Anything mutating (pm2 restarts, deploys, kills) — propose the exact command and wait for my approval first.`;
}

function Dot({ status, size = 7 }) {
  const color = STATUS_COLOR[status] || "#6b7280";
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: status === "up" ? "radial-gradient(circle at 35% 35%, #5effaa, #22c068)" : color,
      boxShadow: status === "up" ? "0 0 5px rgba(34,192,104,0.5)"
               : status === "down" ? "0 0 5px rgba(239,68,68,0.5)" : "none",
    }}/>
  );
}

export function OpsPanel({ opsState, onAsk, onRefresh, onClose }) {
  const checks = Object.entries(opsState?.checks || {}).map(([id, v]) => ({ id, ...v }));
  const byProject = {};
  checks.forEach(c => { (byProject[c.project || "Other"] ||= []).push(c); });
  const PROJECT_ORDER = Array.isArray(opsState?.projectOrder) ? opsState.projectOrder : [];
  const projects = Object.keys(byProject).sort((a, b) => {
    const ia = PROJECT_ORDER.indexOf(a), ib = PROJECT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const down    = checks.filter(c => c.status === "down").length;
  const unknown = checks.filter(c => c.status === "unknown").length;
  const lastRun = checks.length ? Math.max(...checks.map(c => c.lastRun || 0)) : 0;

  const worstOf = list =>
    list.some(c => c.status === "down") ? "down" :
    list.some(c => c.status === "unknown") ? "unknown" : "up";

  return (
    <div style={{ borderBottom: "1px solid var(--tny-line)", background: "var(--tny-deep)", flexShrink: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px 8px" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tny-tx2)", letterSpacing: "0.02em" }}>
          Ops
        </span>
        <span style={{ fontSize: 10, color: "var(--tny-tx3)", fontFamily: "'JetBrains Mono',monospace" }}>
          {checks.length - down - unknown} up{down > 0 && ` · ${down} down`}{unknown > 0 && ` · ${unknown} unknown`}
          {lastRun > 0 && ` · checked ${age(lastRun)}`}
        </span>
        <div style={{ flex: 1 }}/>
        <button onClick={onRefresh}
          style={{ background: "none", border: "1px solid var(--tny-line2)", color: "var(--tny-tx4)", cursor: "pointer", borderRadius: 6, padding: "2px 9px", fontSize: 10, fontFamily: "inherit" }}>
          Refresh
        </button>
        <button onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--tny-tx4)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px", marginLeft: 4 }}>
          ✕
        </button>
      </div>

      {/* Project cards */}
      <div style={{ maxHeight: 320, overflowY: "auto", padding: "0 12px 12px" }}>
        {checks.length === 0 ? (
          <div style={{ textAlign: "center", padding: "24px 0", color: "var(--tny-tx5)", fontSize: 12 }}>
            No ops data yet — the background monitor runs checks every 5 minutes.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 8 }}>
            {projects.map(p => {
              const list = byProject[p];
              return (
                <div key={p} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--tny-line)", background: "rgba(255,255,255,0.015)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                    <Dot status={worstOf(list)} size={8}/>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tny-tx1)" }}>{p}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {list.map(c => (
                      <div key={c.id} title={`${c.detail}\nlast change ${age(c.lastChange)}`}
                        style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                        <Dot status={c.status}/>
                        <span style={{ fontSize: 11, color: "var(--tny-tx2)", flexShrink: 0 }}>{c.label}</span>
                        <span style={{ fontSize: 10, color: "var(--tny-tx3)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, textAlign: "right" }}>
                          {c.detail}
                        </span>
                        {c.status !== "up" && (
                          <button onClick={() => onAsk(fixPrompt(c))}
                            style={{ background: "var(--tny-accent-lo)", border: "1px solid var(--tny-line2)", color: "var(--tny-tx3)", cursor: "pointer", borderRadius: 6, padding: "2px 8px", fontSize: 10, fontFamily: "inherit", flexShrink: 0 }}>
                            Fix
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
