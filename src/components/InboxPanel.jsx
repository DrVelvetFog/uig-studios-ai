// ── Inbox / alerts panel ─────────────────────────────────────────────────────
// Pure presentational component extracted from App.jsx.

// ── Inbox Panel ───────────────────────────────────────────────────────────────
export function InboxPanel({ inbox, onMarkRead, onMarkAllRead, onAsk, onClose, isDark }) {
  const unread      = inbox.filter(f => !f.read).length;
  const sevColor    = { critical:"#ef4444", warning:"#f97316", info:"#60a5fa" };
  const sevIcon     = { critical:"🔴", warning:"🟡", info:"🔵" };
  const sevBg       = { critical:"rgba(239,68,68,0.06)", warning:"rgba(249,115,22,0.06)", info:"rgba(96,165,250,0.05)" };

  return (
    <div style={{ borderBottom:"1px solid var(--tny-line)", background:"var(--tny-deep)", flexShrink:0 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 18px 8px" }}>
        <span style={{ fontSize:12, fontWeight:600, color:"var(--tny-tx2)", letterSpacing:"0.02em" }}>
          Alerts
        </span>
        {unread > 0 && (
          <span style={{ background:"#ef4444", color:"#fff", borderRadius:10, padding:"1px 7px", fontSize:10, fontWeight:700 }}>
            {unread}
          </span>
        )}
        <div style={{ flex:1 }}/>
        {unread > 0 && (
          <button onClick={onMarkAllRead}
            style={{ background:"none", border:"1px solid var(--tny-line2)", color:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"2px 9px", fontSize:10, fontFamily:"inherit" }}>
            Mark all read
          </button>
        )}
        <button onClick={onClose}
          style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:16, lineHeight:1, padding:"2px 4px", marginLeft:4 }}>
          ✕
        </button>
      </div>

      {/* Findings list */}
      <div style={{ maxHeight:280, overflowY:"auto", padding:"0 12px 12px" }}>
        {inbox.length === 0 ? (
          <div style={{ textAlign:"center", padding:"24px 0", color:"var(--tny-tx5)", fontSize:12 }}>
            ✓ No alerts — monitor is active
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {inbox.map(f => (
              <div key={f.id} style={{
                padding:"9px 12px", borderRadius:8,
                background: f.read ? "transparent" : (sevBg[f.severity] || sevBg.info),
                border:`1px solid ${f.read ? "var(--tny-line)" : (sevColor[f.severity] || sevColor.info) + "44"}`,
                opacity: f.read ? 0.55 : 1, transition:"opacity 0.2s",
              }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
                  <span style={{ fontSize:13, flexShrink:0, marginTop:1 }}>{sevIcon[f.severity] || "🔵"}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight: f.read ? 400 : 600, color:"var(--tny-tx1)", marginBottom:2, lineHeight:1.4 }}>
                      {f.title}
                    </div>
                    <div style={{ fontSize:11, color:"var(--tny-tx4)", marginBottom:5, lineHeight:1.5 }}>
                      {f.body}
                    </div>
                    <div style={{ fontSize:10, color:"var(--tny-tx5)", fontFamily:"'JetBrains Mono',monospace" }}>
                      {new Date(f.timestamp).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}
                    </div>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:4, flexShrink:0 }}>
                    <button onClick={() => onAsk(f)}
                      style={{ background:"var(--tny-accent-lo)", border:"1px solid var(--tny-line2)", color:"var(--tny-tx3)", cursor:"pointer", borderRadius:6, padding:"3px 9px", fontSize:10, fontFamily:"inherit", whiteSpace:"nowrap" }}>
                      Ask TonyAI
                    </button>
                    {!f.read && (
                      <button onClick={() => onMarkRead(f.id)}
                        style={{ background:"none", border:"none", color:"var(--tny-tx5)", cursor:"pointer", fontSize:13, lineHeight:1, padding:"2px", alignSelf:"center" }}
                        title="Dismiss">
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
