import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * llm-gateway.cjs is a verbatim port of the sibling vonzio-gateway project's
 * docker/llm-gateway.cjs (CommonJS, no build step, runs in-container). These
 * tests are the contract for its pure translation functions — they are what
 * makes it safe to re-sync the file from upstream without silently breaking
 * request/response/stream translation. The HTTP server only starts under
 * `require.main === module`, so requiring it here is side-effect-free.
 */
const require = createRequire(import.meta.url);
const gw = require("./llm-gateway.cjs") as {
  anthropicToOpenAIRequest: (b: unknown) => any;
  openAIToAnthropicResponse: (b: unknown, m: string) => any;
  makeStreamTranslator: (m: string) => { push: (c: unknown) => string[]; end: () => string[] };
  mapFinishReason: (r: string | null) => string;
  parseContextLimit: (t: string) => number | null;
  trimOpenAIToolsToFit: (oa: any, limit: number) => { dropped: number; changed: boolean };
  estimateTokens: (s: string) => number;
  anthropicToCodexRequest: (b: unknown, o?: unknown) => any;
  makeCodexStreamTranslator: (m: string) => { push: (e: unknown) => string[]; end: () => string[] };
  codexResponsesUrl: (base: string) => string;
  translateMessageToResponses: (m: unknown, out: unknown[]) => void;
  foldAnthropicSSE: (events: string[], model: string) => any;
};

/** Parse an Anthropic SSE string array into typed event objects. */
function parseSSE(events: string[]): any[] {
  return events.map((e) => JSON.parse(/^data: (.*)$/m.exec(e)![1]));
}

/** Parse the gateway's Anthropic SSE strings into {event, data} objects. */
function parseSse(frames: string[]) {
  return frames.map((f) => {
    const ev = /event: (.*)/.exec(f)?.[1];
    const data = /data: (.*)/.exec(f)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

// ─── llm-gateway request translation (Anthropic -> OpenAI) ────────────────

test("llm-gateway request translation (Anthropic -> OpenAI) · flattens system and translates a simple user turn", () => {
  const oa = gw.anthropicToOpenAIRequest({
    model: "gpt-x",
    system: "You are helpful.",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(oa.model, "gpt-x");
  assert.equal(oa.max_tokens, 100);
  assert.deepEqual(oa.messages[0], { role: "system", content: "You are helpful." });
  assert.deepEqual(oa.messages[1], { role: "user", content: "hi" });
});

test("llm-gateway request translation (Anthropic -> OpenAI) · routes the token cap to max_completion_tokens for GPT-5 / o-series, max_tokens otherwise", () => {
  // gpt-4* and OpenAI-compatible servers: legacy max_tokens
  const legacy = gw.anthropicToOpenAIRequest({
    model: "gpt-4o",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(legacy.max_tokens, 256);
  assert.equal(legacy.max_completion_tokens, undefined);

  // GPT-5 family rejects max_tokens — must use max_completion_tokens
  const gpt5 = gw.anthropicToOpenAIRequest({
    model: "gpt-5.4",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(gpt5.max_completion_tokens, 256);
  assert.equal(gpt5.max_tokens, undefined);

  // o-series reasoning models likewise
  const o3 = gw.anthropicToOpenAIRequest({
    model: "o3-mini",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(o3.max_completion_tokens, 256);
  assert.equal(o3.max_tokens, undefined);
});

test("llm-gateway request translation (Anthropic -> OpenAI) · translates tools and tool_choice", () => {
  const oa = gw.anthropicToOpenAIRequest({
    model: "gpt-x",
    max_tokens: 10,
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "any" },
  });
  assert.deepEqual(oa.tools[0], {
    type: "function",
    function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
  });
  assert.equal(oa.tool_choice, "required");
});

test("llm-gateway request translation (Anthropic -> OpenAI) · maps assistant tool_use blocks to tool_calls and user tool_result to role:tool", () => {
  const oa = gw.anthropicToOpenAIRequest({
    model: "gpt-x",
    max_tokens: 10,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result text" }] },
    ],
  });
  const assistant = oa.messages.find((m: any) => m.role === "assistant");
  assert.deepEqual(assistant.tool_calls[0], {
    id: "t1",
    type: "function",
    function: { name: "f", arguments: JSON.stringify({ a: 1 }) },
  });
  const tool = oa.messages.find((m: any) => m.role === "tool");
  assert.deepEqual(tool, { role: "tool", tool_call_id: "t1", content: "result text" });
});

// ─── llm-gateway response translation (OpenAI -> Anthropic) ───────────────

test("llm-gateway response translation (OpenAI -> Anthropic) · translates text + tool_calls and maps finish_reason/usage", () => {
  const anth = gw.openAIToAnthropicResponse(
    {
      id: "cmpl_1",
      model: "gpt-x",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "sure",
            tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    "fallback",
  );
  assert.equal(anth.type, "message");
  assert.equal(anth.stop_reason, "tool_use");
  assert.deepEqual(anth.content[0], { type: "text", text: "sure" });
  assert.deepEqual(anth.content[1], { type: "tool_use", id: "t1", name: "f", input: { a: 1 } });
  assert.deepEqual(anth.usage, { input_tokens: 7, output_tokens: 3 });
});

test("llm-gateway response translation (OpenAI -> Anthropic) · maps finish reasons", () => {
  assert.equal(gw.mapFinishReason("stop"), "end_turn");
  assert.equal(gw.mapFinishReason("length"), "max_tokens");
  assert.equal(gw.mapFinishReason("tool_calls"), "tool_use");
  assert.equal(gw.mapFinishReason(null), "end_turn");
});

// ─── llm-gateway streaming translation (OpenAI SSE -> Anthropic SSE) ──────

test("llm-gateway streaming translation (OpenAI SSE -> Anthropic SSE) · emits a well-formed Anthropic event sequence for text", () => {
  const tr = gw.makeStreamTranslator("gpt-x");
  const frames = [
    ...tr.push({ choices: [{ delta: { content: "Hel" } }] }),
    ...tr.push({ choices: [{ delta: { content: "lo" } }] }),
    ...tr.push({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    ...tr.end(),
  ];
  const events = parseSse(frames);
  const types = events.map((e) => e.event);
  assert.equal(types[0], "message_start");
  assert.ok(types.includes("content_block_start"));
  assert.equal(types.filter((t) => t === "content_block_delta").length, 2);
  assert.ok(types.includes("content_block_stop"));
  const delta = events.find((e) => e.event === "message_delta");
  assert.equal(delta?.data.delta.stop_reason, "end_turn");
  assert.equal(delta?.data.usage.output_tokens, 2);
  assert.equal(types[types.length - 1], "message_stop");
});

test("llm-gateway streaming translation (OpenAI SSE -> Anthropic SSE) · opens a tool_use block and streams input_json_delta for tool calls", () => {
  const tr = gw.makeStreamTranslator("gpt-x");
  const frames = [
    ...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "" } }] } }] }),
    ...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }),
    ...tr.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ...tr.end(),
  ];
  const events = parseSse(frames);
  const start = events.find((e) => e.event === "content_block_start");
  assert.equal(start?.data.content_block.type, "tool_use");
  assert.equal(start?.data.content_block.name, "f");
  const jsonDelta = events.find(
    (e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta",
  );
  assert.equal(jsonDelta?.data.delta.partial_json, '{"a":1}');
  const msgDelta = events.find((e) => e.event === "message_delta");
  assert.equal(msgDelta?.data.delta.stop_reason, "tool_use");
});

// ─── llm-gateway adaptive tool trimming ────────────────────────────────────

test("llm-gateway adaptive tool trimming · parseContextLimit reads the model's limit (or null for non-context errors)", () => {
  assert.equal(gw.parseContextLimit("This model's maximum context length is 8192 tokens. However..."), 8192);
  assert.equal(gw.parseContextLimit('{"code":"context_length_exceeded"}'), 8192); // fallback
  assert.equal(gw.parseContextLimit('{"error":"Incorrect API key provided"}'), null);
  assert.equal(gw.parseContextLimit(""), null);
});

test("llm-gateway adaptive tool trimming · trimOpenAIToolsToFit keeps essential tools first and drops the long tail to fit", () => {
  // 30 fat tools (~ a few hundred tokens each via a long description).
  const desc = "x".repeat(800);
  const mk = (name: string) => ({ type: "function", function: { name, description: desc, parameters: { type: "object", properties: {} } } });
  const oa: any = {
    model: "small",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      ...["mcp__a", "mcp__b", "mcp__c"].map(mk), // unknown/MCP — dropped first
      mk("Bash"), mk("Read"), mk("Write"), mk("Edit"), mk("Grep"),
    ],
  };
  const before = oa.tools.length;
  const { dropped } = gw.trimOpenAIToolsToFit(oa, 1200); // tiny budget
  assert.ok(dropped > 0);
  const kept = (oa.tools ?? []).map((t: any) => t.function.name);
  // Core built-ins outrank the MCP tail under a tiny budget, so survivors are core.
  for (const name of kept) assert.ok(!/^mcp__/.test(name));
  assert.equal(before - kept.length, dropped);
});

test("llm-gateway adaptive tool trimming · trimOpenAIToolsToFit drops all tools (and tool_choice) when nothing fits", () => {
  const oa: any = {
    messages: [{ role: "user", content: "x".repeat(40000) }], // huge prompt
    tools: [{ type: "function", function: { name: "Bash", description: "y".repeat(2000), parameters: {} } }],
    tool_choice: "auto",
  };
  const { dropped } = gw.trimOpenAIToolsToFit(oa, 8192);
  assert.equal(dropped, 1);
  assert.equal(oa.tools, undefined);
  assert.equal(oa.tool_choice, undefined);
});

test("llm-gateway adaptive tool trimming · caps long descriptions before dropping tools (keeps all when capping fits)", () => {
  const mk = (name: string) => ({ type: "function", function: { name, description: "d".repeat(5000), parameters: {} } });
  const oa: any = {
    messages: [{ role: "user", content: "hi" }],
    tools: [mk("Bash"), mk("Read"), mk("mcp__x")],
  };
  // Too small for 3×5000-char descs, ample for 3 capped (≤600) ones.
  const r = gw.trimOpenAIToolsToFit(oa, 1024 + 10 + 700);
  assert.equal(r.dropped, 0); // nothing dropped — capping alone fit
  assert.equal(r.changed, true); // but we did change (capped), so retry
  assert.equal(oa.tools.length, 3);
  for (const t of oa.tools) assert.ok(t.function.description.length <= 601);
});

test("llm-gateway adaptive tool trimming · priority: core built-ins > MCP/configured > generic long tail", () => {
  const mk = (name: string) => ({ type: "function", function: { name, description: "d".repeat(200), parameters: {} } });
  const web = mk("WebSearch"); // generic long tail — dropped first
  const mcp = mk("mcp__db__query"); // operator-configured — kept over long tail
  const bash = mk("Bash"); // core — kept first
  const oa: any = { messages: [{ role: "user", content: "hi" }], tools: [web, mcp, bash] };
  // Budget == exactly Bash + mcp, so the long-tail WebSearch can't fit.
  const cBash = gw.estimateTokens(JSON.stringify(bash));
  const cMcp = gw.estimateTokens(JSON.stringify(mcp));
  const msgTok = gw.estimateTokens(JSON.stringify(oa.messages));
  const r = gw.trimOpenAIToolsToFit(oa, cBash + cMcp + msgTok + 1024);
  assert.equal(r.dropped, 1);
  const kept = (oa.tools ?? []).map((t: any) => t.function.name);
  assert.ok(kept.includes("Bash"));
  assert.ok(kept.includes("mcp__db__query"));
  assert.ok(!kept.includes("WebSearch"));
});

test("llm-gateway adaptive tool trimming · resets a forced tool_choice to auto when that tool is trimmed away", () => {
  const oa: any = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "Bash", description: "run a command", parameters: {} } }, // small, kept
      { type: "function", function: { name: "mcp__rare", description: "z".repeat(4000), parameters: {} } }, // fat, dropped
    ],
    tool_choice: { type: "function", function: { name: "mcp__rare" } },
  };
  // Budget fits the small Bash tool but not the fat mcp__rare one.
  gw.trimOpenAIToolsToFit(oa, 1024 + 10 + 120);
  const names = (oa.tools ?? []).map((t: any) => t.function.name);
  assert.ok(names.includes("Bash"));
  assert.ok(!names.includes("mcp__rare"));
  assert.equal(oa.tool_choice, "auto");
});

// ─── Codex mode: Anthropic <-> OpenAI Responses API ───────────────────────

test("codex request translation (Anthropic -> Responses API) · maps system→instructions, messages→input, and forces store:false", () => {
  const cx = gw.anthropicToCodexRequest({
    model: "gpt-5.5",
    system: "be terse",
    stream: true,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(cx.model, "gpt-5.5");
  assert.equal(cx.instructions, "be terse");
  assert.equal(cx.store, false);
  assert.equal(cx.stream, true);
  // We deliberately do NOT request reasoning.encrypted_content (we can't carry
  // it back through the Anthropic wire format, and requesting-then-dropping it
  // breaks tool continuation on some backends).
  assert.equal(cx.include, undefined);
  // Codex rejects max_output_tokens — the SDK's max_tokens must be dropped.
  assert.equal(cx.max_output_tokens, undefined);
  assert.deepEqual(cx.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
});

test("codex request translation (Anthropic -> Responses API) · emits function_call / function_call_output as top-level input items", () => {
  const input: any[] = [];
  gw.translateMessageToResponses(
    { role: "assistant", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "call_1", name: "ls", input: { path: "/" } }] },
    input,
  );
  gw.translateMessageToResponses(
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }] },
    input,
  );
  assert.deepEqual(input[0], { role: "assistant", content: [{ type: "output_text", text: "let me check" }] });
  assert.deepEqual(input[1], { type: "function_call", call_id: "call_1", name: "ls", arguments: JSON.stringify({ path: "/" }) });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_1", output: "file.txt" });
});

test("codex request translation (Anthropic -> Responses API) · translates tools to the flat Responses shape", () => {
  const cx = gw.anthropicToCodexRequest({
    model: "gpt-5.5",
    messages: [],
    tools: [{ name: "ls", description: "list", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: "ls" },
  });
  // toMatchObject equivalent: assert the subset of fields we care about.
  assert.equal(cx.tools[0].type, "function");
  assert.equal(cx.tools[0].name, "ls");
  assert.equal(cx.tools[0].description, "list");
  assert.deepEqual(cx.tool_choice, { type: "function", name: "ls" });
});

test("codexResponsesUrl · appends /codex/responses and tolerates partial bases", () => {
  assert.equal(gw.codexResponsesUrl("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(gw.codexResponsesUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(gw.codexResponsesUrl("https://x/backend-api/codex/responses"), "https://x/backend-api/codex/responses");
});

// ─── codex streaming translation (Responses SSE -> Anthropic SSE) ─────────

// These are the REAL event shapes captured from chatgpt.com/backend-api/codex.
const codexStream = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", encrypted_content: "xxx" } },
  { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
  { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "po" },
  { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "ng" },
  { type: "response.output_text.done", item_id: "msg_1" },
  { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 21, output_tokens: 17 } } },
];

test("codex streaming translation (Responses SSE -> Anthropic SSE) · drops reasoning, streams text, and closes with usage + end_turn", () => {
  const tr = gw.makeCodexStreamTranslator("gpt-5.5");
  const out: string[] = [];
  for (const e of codexStream) out.push(...tr.push(e));
  out.push(...tr.end());
  const evts = parseSSE(out);
  const types = evts.map((e) => e.type);
  assert.equal(types[0], "message_start");
  assert.ok(types.includes("content_block_start"));
  // exactly one text block opened (reasoning dropped)
  assert.equal(evts.filter((e) => e.type === "content_block_start").length, 1);
  const text = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(text, "pong");
  const md = evts.find((e) => e.type === "message_delta");
  assert.equal(md.delta.stop_reason, "end_turn");
  assert.deepEqual(md.usage, { input_tokens: 21, output_tokens: 17 });
  assert.equal(types.at(-1), "message_stop");
});

test("codex streaming translation (Responses SSE -> Anthropic SSE) · maps a function call to a tool_use block with input_json_delta and tool_use stop", () => {
  const tr = gw.makeCodexStreamTranslator("gpt-5.5");
  const evseq = [
    { type: "response.created", response: { id: "r" } },
    { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_abc", name: "ls" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"/"}' },
    { type: "response.output_item.done", item: { id: "fc_1", type: "function_call" } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } },
  ];
  const out: string[] = [];
  for (const e of evseq) out.push(...tr.push(e));
  out.push(...tr.end());
  const evts = parseSSE(out);
  const start = evts.find((e) => e.type === "content_block_start");
  assert.equal(start.content_block.type, "tool_use");
  assert.equal(start.content_block.id, "call_abc");
  assert.equal(start.content_block.name, "ls");
  const json = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("");
  assert.deepEqual(JSON.parse(json), { path: "/" });
  assert.equal(evts.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
});

test("codex streaming translation (Responses SSE -> Anthropic SSE) · falls back to the completed item's arguments when a tool call streams no deltas", () => {
  const tr = gw.makeCodexStreamTranslator("gpt-5.5");
  const out: string[] = [];
  for (const e of [
    { type: "response.created", response: { id: "r" } },
    { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_x", name: "ls" } },
    // no function_call_arguments.delta events — args only on the done item
    { type: "response.output_item.done", item: { id: "fc_2", type: "function_call", arguments: '{"path":"/tmp"}' } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]) out.push(...tr.push(e));
  out.push(...tr.end());
  const evts = parseSSE(out);
  const json = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("");
  assert.deepEqual(JSON.parse(json), { path: "/tmp" });
});

// ─── foldAnthropicSSE (non-streaming collapse) ─────────────────────────────

test("foldAnthropicSSE (non-streaming collapse) · reassembles text + usage into a Messages response", () => {
  const tr = gw.makeCodexStreamTranslator("gpt-5.5");
  const out: string[] = [];
  for (const e of [
    { type: "response.output_item.added", item: { id: "m", type: "message" } },
    { type: "response.output_text.delta", item_id: "m", delta: "hello" },
    { type: "response.output_item.done", item: { id: "m" } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } },
  ]) out.push(...tr.push(e));
  out.push(...tr.end());
  const msg = gw.foldAnthropicSSE(out, "gpt-5.5");
  assert.equal(msg.type, "message");
  assert.deepEqual(msg.content, [{ type: "text", text: "hello" }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.usage, { input_tokens: 2, output_tokens: 1 });
});
