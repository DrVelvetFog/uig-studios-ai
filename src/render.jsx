// ── Message rendering primitives ─────────────────────────────────────────────
// Pure presentational helpers extracted from App.jsx. No Tauri imports.
import { useState } from "react";

export function TypingDots({ color }) {
  return (
    <div style={{ display:"flex", gap:5, alignItems:"center", padding:"12px 16px" }}>
      {[0,1,2].map(i => (
        <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:color||"var(--tny-tx3)", animation:`bounce 1.2s ease-in-out ${i*0.2}s infinite` }}/>
      ))}
    </div>
  );
}

export const RUNNABLE_LANGS = new Set(["python","python3","py","javascript","js","typescript","ts","bash","sh","shell","zsh"]);

export function CodeBlock({ code, lang, onRun }) {
  const [copied,  setCopied]  = useState(false);
  const [running, setRunning] = useState(false);
  const isOutput = lang === "output";
  const canRun   = onRun && RUNNABLE_LANGS.has((lang||"").toLowerCase());

  return (
    <div style={{ margin:"8px 0", borderRadius:8, overflow:"hidden", border:`1px solid ${isOutput?"var(--tny-line)":"var(--tny-line)"}` }}>
      <div style={{ background: isOutput ? "rgba(34,197,94,0.06)" : "var(--tny-raised)", padding:"6px 12px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:`1px solid ${isOutput?"rgba(34,197,94,0.12)":"var(--tny-line)"}` }}>
        <span style={{ fontSize:11, color: isOutput ? "#22c55e" : "var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace" }}>
          {isOutput ? "▶ output" : (lang||"code")}
        </span>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {canRun && (
            <button
              onClick={async () => { setRunning(true); try { await onRun(code, lang); } finally { setRunning(false); } }}
              disabled={running}
              style={{ background:"none", border:"none", color: running ? "var(--tny-tx4)" : "#22c55e", cursor: running ? "default" : "pointer", fontSize:11, fontFamily:"inherit", display:"flex", alignItems:"center", gap:3 }}>
              {running ? "⟳ running…" : "▶ run"}
            </button>
          )}
          {!isOutput && (
            <button onClick={()=>{navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),2000);}}
              style={{ background:"none", border:"none", color:copied?"var(--tny-tx2)":"var(--tny-tx4)", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
              {copied?"✓ copied":"copy"}
            </button>
          )}
        </div>
      </div>
      <pre style={{ margin:0, padding:"14px 16px", background: isOutput ? "rgba(34,197,94,0.03)" : "var(--tny-code)", overflowX:"auto", fontSize:13, lineHeight:1.6, color: isOutput ? "#86efac" : "var(--tny-input)", fontFamily:"'JetBrains Mono',monospace" }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── ThinkBlock — collapsible <think>…</think> for deepseek-r1 ─────────────────
export function ThinkBlock({ text, streaming = false }) {
  const [open, setOpen] = useState(streaming);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div style={{ margin:"4px 0 8px", borderRadius:8, border:"1px solid rgba(139,92,246,0.22)", overflow:"hidden", fontSize:13 }}>
      <button onClick={()=>setOpen(p=>!p)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:8, background:"rgba(139,92,246,0.07)", border:"none", padding:"6px 12px", cursor:"pointer", textAlign:"left", color:"var(--tny-tx4)", fontSize:12, fontFamily:"inherit", lineHeight:1 }}>
        <span style={{ fontSize:14 }}>🧠</span>
        <span style={{ flex:1, color:"var(--tny-tx3)" }}>{streaming ? "Reasoning…" : "Reasoning"}</span>
        {!streaming && <span style={{ fontSize:10, color:"var(--tny-tx5)", fontFamily:"'JetBrains Mono',monospace" }}>{words}w</span>}
        <span style={{ fontSize:10, color:"rgba(139,92,246,0.7)", marginLeft:4 }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ padding:"10px 14px", background:"rgba(139,92,246,0.03)", borderTop:"1px solid rgba(139,92,246,0.12)", fontSize:12, color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", lineHeight:1.65, maxHeight:320, overflowY:"auto" }}>
          {text.trim()}
        </div>
      )}
    </div>
  );
}

// ── Inline markdown → React nodes ────────────────────────────────────────────
// Handles: **bold**, *italic*, `code`, [link](url)
export function renderInline(text) {
  const parts = [];
  // Combined regex: **bold** | *italic* | `code` | [label](url)
  const re = /\*\*(.+?)\*\*|\*([^*\n]+?)\*|`([^`]+?)`|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={i++}>{text.slice(last, m.index)}</span>);
    if (m[1] !== undefined) parts.push(<strong key={i++} style={{ fontWeight:600, color:"inherit" }}>{m[1]}</strong>);
    else if (m[2] !== undefined) parts.push(<em key={i++}>{m[2]}</em>);
    else if (m[3] !== undefined) parts.push(<code key={i++} style={{ fontFamily:"'JetBrains Mono','Menlo',monospace", fontSize:"0.85em", background:"rgba(155,127,232,0.15)", border:"0.5px solid rgba(130,100,220,0.25)", borderRadius:4, padding:"1px 5px" }}>{m[3]}</code>);
    else if (m[4] !== undefined) parts.push(<a key={i++} href={m[5]} target="_blank" rel="noopener noreferrer" style={{ color:"var(--tny-accent-hi)", textDecoration:"underline", textDecorationColor:"rgba(155,127,232,0.4)" }}>{m[4]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={i++}>{text.slice(last)}</span>);
  return parts.length ? parts : [text];
}

// Render a block of plain text with paragraph, heading, and list support
export function renderTextBlock(text, keyPrefix) {
  const lines = text.split("\n");
  const blocks = [];
  let listItems = [], listType = null, bi = 0;

  function flushList() {
    if (!listItems.length) return;
    const Tag = listType === "ul" ? "ul" : "ol";
    blocks.push(
      <Tag key={`${keyPrefix}-list-${bi++}`}
        style={{ marginLeft:20, marginTop:4, marginBottom:8, display:"flex", flexDirection:"column", gap:2 }}>
        {listItems.map((li, i) => (
          <li key={i} style={{ lineHeight:1.65 }}>{renderInline(li)}</li>
        ))}
      </Tag>
    );
    listItems = []; listType = null;
  }

  for (const raw of lines) {
    const line = raw;
    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3 || h2 || h1) {
      flushList();
      const content = (h3||h2||h1)[1];
      const sz = h1 ? "1.1em" : h2 ? "1.05em" : "1em";
      blocks.push(<p key={`${keyPrefix}-h-${bi++}`} style={{ fontWeight:600, fontSize:sz, marginTop:12, marginBottom:4, color:"var(--tny-tx1)" }}>{renderInline(content)}</p>);
      continue;
    }
    // Unordered list
    const ul = line.match(/^[\-\*\•] (.+)/);
    if (ul) {
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(ul[1]);
      continue;
    }
    // Ordered list
    const ol = line.match(/^\d+[\.\)] (.+)/);
    if (ol) {
      if (listType !== "ol") { flushList(); listType = "ol"; }
      listItems.push(ol[1]);
      continue;
    }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      flushList();
      blocks.push(<hr key={`${keyPrefix}-hr-${bi++}`} style={{ border:"none", borderTop:"0.5px solid var(--tny-line2)", margin:"10px 0" }}/>);
      continue;
    }
    // Empty line → paragraph break
    if (!line.trim()) {
      flushList();
      if (blocks.length) blocks.push(<div key={`${keyPrefix}-br-${bi++}`} style={{ height:6 }}/>);
      continue;
    }
    // Regular line
    flushList();
    blocks.push(<p key={`${keyPrefix}-p-${bi++}`} style={{ margin:0, lineHeight:1.7 }}>{renderInline(line)}</p>);
  }
  flushList();
  return blocks;
}

// Split plain text on code fences — used by renderMessage
export function renderCodeSegment(text, keyPrefix, onRun) {
  return text.split(/(```[\s\S]*?```)/g).map((seg, j) => {
    if (seg.startsWith("```")) {
      const lines = seg.slice(3,-3).split("\n");
      const lang  = lines[0].trim();
      const code  = lines.slice(1).join("\n");
      return <CodeBlock key={`${keyPrefix}-${j}`} code={code} lang={lang} onRun={onRun}/>;
    }
    // Non-code segment — render with full markdown support
    return <div key={`${keyPrefix}-${j}`} style={{ display:"contents" }}>{renderTextBlock(seg, `${keyPrefix}-${j}`)}</div>;
  });
}

// Renders a message string: collapses <think>…</think> blocks, renders ```code``` fences
export function renderMessage(text, onRun) {
  const result = [];
  const thinkRe = /<think>([\s\S]*?)<\/think>/gi;
  let lastIdx = 0, match, tIdx = 0;

  while ((match = thinkRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      result.push(...renderCodeSegment(text.slice(lastIdx, match.index), `t${tIdx}a`, onRun));
    }
    // Completed <think> block — collapsed by default (key changes each time → new component instance → closed)
    result.push(<ThinkBlock key={`think-c-${tIdx}`} text={match[1]} />);
    lastIdx = match.index + match[0].length;
    tIdx++;
  }

  const remaining = text.slice(lastIdx);
  const unclosedIdx = remaining.indexOf("<think>");
  if (unclosedIdx !== -1) {
    // Still streaming — incomplete <think> block open by default
    const before = remaining.slice(0, unclosedIdx);
    const thinkContent = remaining.slice(unclosedIdx + 7);
    if (before) result.push(...renderCodeSegment(before, `t${tIdx}b`, onRun));
    result.push(<ThinkBlock key="think-s" text={thinkContent} streaming={true} />);
  } else {
    result.push(...renderCodeSegment(remaining, `t${tIdx}c`, onRun));
  }

  return result;
}
