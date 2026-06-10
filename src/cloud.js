// ── Cloud model routing + wire-format conversion ─────────────────────────────
// Pure module. TonyAI speaks Ollama's chat format internally; OpenRouter and
// OpenAI both speak OpenAI Chat Completions. This module owns the mapping.
//
// Cloud model ids are prefixed so routing is a string check:
//   "or/anthropic/claude-sonnet-4.6"  → OpenRouter
//   "oai/gpt-5"                       → OpenAI direct

export function isCloudModel(m) {
  return typeof m === "string" && (m.startsWith("or/") || m.startsWith("oai/"));
}

export function cloudProvider(m) {
  if (typeof m !== "string") return null;
  if (m.startsWith("or/"))  return "openrouter";
  if (m.startsWith("oai/")) return "openai";
  return null;
}

export function cloudModelId(m) {
  return String(m || "").replace(/^or\//, "").replace(/^oai\//, "");
}

export function cloudDisplayName(m) {
  if (m.startsWith("or/"))  return m.slice(3);
  if (m.startsWith("oai/")) return m.slice(4);
  return m;
}

// Convert Ollama-format messages → OpenAI Chat Completions messages.
//
// Differences handled:
//  - assistant tool_calls: arguments must be a JSON *string*, each call needs
//    an id, and the following role:"tool" results must reference those ids.
//    Ollama's native tool calls often have no id and TonyAI's generated result
//    ids don't always match — so ids are (re)assigned here and the tool results
//    that follow each assistant turn are re-linked positionally.
//  - tool messages: OpenAI shape is {role:"tool", tool_call_id, content} (no name).
//  - images on user messages are dropped (vision passthrough is a later step).
export function toOpenAIMessages(ollamaMessages) {
  const out = [];
  let pendingCallIds = [];   // ids from the most recent assistant tool_calls turn
  let pendingIdx = 0;
  let callSeq = 0;

  for (const msg of (ollamaMessages || [])) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const calls = msg.tool_calls.map(tc => {
        const id = tc.id && String(tc.id).trim() ? String(tc.id) : `call_${callSeq++}`;
        const rawArgs = tc.function?.arguments;
        return {
          id,
          type: "function",
          function: {
            name: tc.function?.name || "unknown",
            arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}),
          },
        };
      });
      pendingCallIds = calls.map(c => c.id);
      pendingIdx = 0;
      out.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
    } else if (msg.role === "tool") {
      // Re-link to the preceding assistant turn's calls, in order.
      const id = pendingCallIds[pendingIdx] ?? msg.tool_call_id ?? `call_${callSeq++}`;
      pendingIdx++;
      out.push({ role: "tool", tool_call_id: id, content: String(msg.content ?? "") });
    } else {
      out.push({ role: msg.role, content: msg.content ?? "" });
      if (msg.role !== "tool") { pendingCallIds = []; pendingIdx = 0; }
    }
  }
  return out;
}

// Build the full Chat Completions request body.
// `provider` controls the usage-reporting extension each API expects.
export function toOpenAIBody({ model, messages, tools, temperature, stream = true }, provider) {
  const body = {
    model,
    messages: toOpenAIMessages(messages),
    stream,
  };
  if (tools?.length) body.tools = tools; // same {type:"function",function:{...}} shape
  if (typeof temperature === "number") body.temperature = temperature;
  if (stream) {
    if (provider === "openrouter") body.usage = { include: true };
    else body.stream_options = { include_usage: true };
  }
  return body;
}
