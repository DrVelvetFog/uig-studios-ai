import { describe, it, expect } from "vitest";
import { isCloudModel, cloudProvider, cloudModelId, toOpenAIMessages, toOpenAIBody } from "./cloud.js";

describe("cloud model routing", () => {
  it("detects prefixes and providers", () => {
    expect(isCloudModel("or/anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isCloudModel("oai/gpt-5")).toBe(true);
    expect(isCloudModel("hermes3:latest")).toBe(false);
    expect(cloudProvider("or/x")).toBe("openrouter");
    expect(cloudProvider("oai/x")).toBe("openai");
    expect(cloudProvider("qwen2.5-coder:14b")).toBeNull();
    expect(cloudModelId("or/anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(cloudModelId("oai/gpt-5")).toBe("gpt-5");
  });
});

describe("toOpenAIMessages", () => {
  it("stringifies tool arguments and links tool results to call ids", () => {
    const out = toOpenAIMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "list /tmp" },
      // Ollama native tool call: object args, NO id
      { role: "assistant", content: "", tool_calls: [{ function: { name: "list_dir", arguments: { path: "/tmp" } } }] },
      // TonyAI's result with a generated id that doesn't match anything
      { role: "tool", content: "a\nb", tool_call_id: "call_1749999999", name: "list_dir" },
    ]);

    const asst = out[2];
    expect(asst.tool_calls[0].type).toBe("function");
    expect(typeof asst.tool_calls[0].function.arguments).toBe("string");
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ path: "/tmp" });

    const toolMsg = out[3];
    expect(toolMsg.tool_call_id).toBe(asst.tool_calls[0].id); // re-linked
    expect(toolMsg.name).toBeUndefined();
  });

  it("links multiple parallel tool results positionally", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: "", tool_calls: [
        { function: { name: "a", arguments: {} } },
        { function: { name: "b", arguments: {} } },
      ]},
      { role: "tool", content: "ra" },
      { role: "tool", content: "rb" },
    ]);
    expect(out[1].tool_call_id).toBe(out[0].tool_calls[0].id);
    expect(out[2].tool_call_id).toBe(out[0].tool_calls[1].id);
    expect(out[1].tool_call_id).not.toBe(out[2].tool_call_id);
  });

  it("preserves existing call ids and passes plain messages through", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: "hi", tool_calls: [{ id: "call_keep", function: { name: "x", arguments: "{\"a\":1}" } }] },
      { role: "tool", content: "ok" },
      { role: "user", content: "next" },
    ]);
    expect(out[0].tool_calls[0].id).toBe("call_keep");
    expect(out[0].tool_calls[0].function.arguments).toBe("{\"a\":1}");
    expect(out[1].tool_call_id).toBe("call_keep");
    expect(out[2]).toEqual({ role: "user", content: "next" });
  });
});

describe("toOpenAIBody", () => {
  const msgs = [{ role: "user", content: "hi" }];

  it("adds the provider-specific usage option when streaming", () => {
    expect(toOpenAIBody({ model: "m", messages: msgs }, "openrouter").usage).toEqual({ include: true });
    expect(toOpenAIBody({ model: "m", messages: msgs }, "openai").stream_options).toEqual({ include_usage: true });
  });

  it("omits tools/temperature when absent and usage opts when not streaming", () => {
    const b = toOpenAIBody({ model: "m", messages: msgs, stream: false }, "openai");
    expect(b.tools).toBeUndefined();
    expect(b.temperature).toBeUndefined();
    expect(b.stream_options).toBeUndefined();
    expect(b.stream).toBe(false);
  });

  it("passes tools through unchanged", () => {
    const tools = [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }];
    expect(toOpenAIBody({ model: "m", messages: msgs, tools, temperature: 0.3 }, "openrouter").tools).toBe(tools);
  });
});
