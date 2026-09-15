import { describe, expect, it } from "vitest";
import {
  ChunkWriter,
  OutputParser,
  SSE_DONE,
  toTemplateMessages,
  type OutputEvent,
  type WireMessage,
} from "./chat.js";
import type { ToolDefinition } from "./protocol.js";

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "count",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" }, all: { type: "boolean" } },
      },
    },
  },
];

/** Feed the text one character at a time — the worst case for a streaming parser. */
function charByChar(parser: OutputParser, text: string): OutputEvent[] {
  const events: OutputEvent[] = [];
  for (const char of text) events.push(...parser.push(char));
  events.push(...parser.finish());
  return events;
}

/** Concatenate adjacent text events so assertions don't depend on chunking. */
function merged(events: OutputEvent[]): OutputEvent[] {
  const out: OutputEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && last.type === event.type && event.type !== "tool_call" && last.type !== "tool_call") {
      last.text += event.type === "text" || event.type === "reasoning" ? event.text : "";
    } else {
      out.push({ ...event });
    }
  }
  return out;
}

describe("toTemplateMessages", () => {
  it("decodes tool arguments from JSON strings into objects", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "README" },
    ];
    const out = toTemplateMessages(messages);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: { command: "ls" } } }],
    });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "README" });
  });

  it("keeps unparseable arguments as text rather than dropping them", () => {
    const [out] = toTemplateMessages([
      {
        role: "assistant",
        content: "x",
        tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "not json" } }],
      },
    ]);
    expect(out).toMatchObject({
      tool_calls: [{ function: { arguments: { input: "not json" } } }],
    });
  });
});

describe("OutputParser", () => {
  it("splits reasoning from the reply and drops the blank line after </think>", () => {
    const parser = new OutputParser({ thinking: true });
    const events = merged(charByChar(parser, "let me see\n</think>\n\nThe answer is 4."));
    expect(events).toEqual([
      { type: "reasoning", text: "let me see\n" },
      { type: "text", text: "The answer is 4." },
    ]);
  });

  it("passes plain text through when thinking is off", () => {
    const parser = new OutputParser({ thinking: false });
    expect(merged(charByChar(parser, "Hello there"))).toEqual([{ type: "text", text: "Hello there" }]);
  });

  it("parses a bare-value tool call", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const events = charByChar(
      parser,
      'I will list.\n<function name="bash"><param name="command">ls -la</param></function>',
    );
    expect(merged(events)).toEqual([
      { type: "text", text: "I will list." },
      { type: "tool_call", name: "bash", arguments: { command: "ls -la" } },
    ]);
  });

  it("unwraps CDATA, including the split the template uses for ]]>", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const xml =
      '<function name="bash"><param name="command"><![CDATA[echo "a]]]]><![CDATA[>b" && cat <<EOF\nx\nEOF]]></param></function>';
    expect(charByChar(parser, xml)).toEqual([
      { type: "tool_call", name: "bash", arguments: { command: 'echo "a]]>b" && cat <<EOF\nx\nEOF' } },
    ]);
  });

  it("does not end a CDATA value at a </param> inside it", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const xml =
      '<function name="bash"><param name="command"><![CDATA[echo "</param></function>"]]></param></function>';
    expect(charByChar(parser, xml)).toEqual([
      { type: "tool_call", name: "bash", arguments: { command: 'echo "</param></function>"' } },
    ]);
  });

  it("handles several calls in one reply, and whitespace between them", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const xml =
      '<function name="bash"><param name="command">a</param></function>\n\n' +
      '<function name="bash">\n  <param name="command">b</param>\n</function>\nDone.';
    expect(merged(charByChar(parser, xml))).toEqual([
      { type: "tool_call", name: "bash", arguments: { command: "a" } },
      { type: "tool_call", name: "bash", arguments: { command: "b" } },
      { type: "text", text: "Done." },
    ]);
  });

  it("casts values to the schema's declared types", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const xml =
      '<function name="count"><param name="limit">10</param><param name="all">true</param></function>';
    expect(charByChar(parser, xml)).toEqual([
      { type: "tool_call", name: "count", arguments: { limit: 10, all: true } },
    ]);
  });

  it("treats text that merely starts with <function as text", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const events = merged(charByChar(parser, "see <functional> tags and <func> too"));
    expect(events).toEqual([{ type: "text", text: "see <functional> tags and <func> too" }]);
  });

  it("flushes an unfinished call as text at end of stream", () => {
    const parser = new OutputParser({ thinking: false, tools: TOOLS });
    const events = merged(charByChar(parser, 'ok <function name="bash"><param name="command">ls'));
    expect(events).toEqual([{ type: "text", text: 'ok <function name="bash"><param name="command">ls' }]);
  });

  it("produces the same events regardless of how the stream is chunked", () => {
    const text =
      'thinking about it</think>\n\nSure.\n<function name="bash"><param name="command"><![CDATA[a\nb]]></param></function>';
    const expected = merged(charByChar(new OutputParser({ thinking: true, tools: TOOLS }), text));

    const whole = new OutputParser({ thinking: true, tools: TOOLS });
    expect(merged([...whole.push(text), ...whole.finish()])).toEqual(expected);

    const chunked = new OutputParser({ thinking: true, tools: TOOLS });
    const events: OutputEvent[] = [];
    for (let i = 0; i < text.length; i += 7) events.push(...chunked.push(text.slice(i, i + 7)));
    events.push(...chunked.finish());
    expect(merged(events)).toEqual(expected);
  });

  it("reports whether it is still inside the think block", () => {
    const parser = new OutputParser({ thinking: true });
    expect(parser.reasoning).toBe(true);
    parser.push("hmm</think>");
    expect(parser.reasoning).toBe(false);
  });
});

describe("ChunkWriter", () => {
  const parse = (sse: string): unknown[] =>
    sse
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ""))
      .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));

  it("encodes text as a content delta", () => {
    const writer = new ChunkWriter("id", "m");
    expect(parse(writer.event({ type: "text", text: "hi" }))).toEqual([
      { id: "id", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
    ]);
  });

  it("encodes reasoning under reasoning_content, which ofx ignores", () => {
    const writer = new ChunkWriter("id", "m");
    expect(parse(writer.event({ type: "reasoning", text: "hmm" }))).toMatchObject([
      { choices: [{ delta: { reasoning_content: "hmm" } }] },
    ]);
  });

  it("sends each tool call whole with a stable index, and finishes with tool_calls", () => {
    const writer = new ChunkWriter("id", "m");
    const first = parse(writer.event({ type: "tool_call", name: "bash", arguments: { command: "ls" } }));
    const second = parse(writer.event({ type: "tool_call", name: "bash", arguments: { command: "pwd" } }));
    expect(first).toMatchObject([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_id_0", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
              ],
            },
          },
        ],
      },
    ]);
    expect(second).toMatchObject([{ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_id_1" }] } }] }]);

    const tail = parse(writer.finish("stop", { promptTokens: 10, completionTokens: 5 }));
    expect(tail).toEqual([
      { id: "id", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { id: "id", object: "chat.completion.chunk", model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      "[DONE]",
    ]);
  });

  it("passes the model's own finish reason through when there were no calls", () => {
    const writer = new ChunkWriter("id", "m");
    const tail = writer.finish("length", { promptTokens: 1, completionTokens: 2 });
    expect(parse(tail)[0]).toMatchObject({ choices: [{ finish_reason: "length" }] });
    expect(tail.endsWith(SSE_DONE)).toBe(true);
  });
});
