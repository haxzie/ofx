import type { TemplateMessage, ToolDefinition } from "./protocol.js";

/**
 * Between OpenAI Chat Completions and MiniCPM's wire format.
 *
 * ofx talks to the local model through its OpenAI adapter, so the request is
 * a Chat Completions body and the reply must be a Chat Completions SSE
 * stream. MiniCPM itself speaks ChatML with tool calls as XML:
 *
 *     <function name="bash"><param name="command">ls</param></function>
 *
 * This module is pure so the parsing can be tested without a model.
 */

/** The request body ofx's OpenAI adapter sends. */
export interface ChatRequest {
  model?: string;
  messages: WireMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  max_completion_tokens?: number;
}

export type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Reshape the wire messages for the chat template.
 *
 * OpenAI carries tool arguments as a JSON string; the template iterates them
 * as a mapping, so they are decoded here. Everything else passes through.
 */
export function toTemplateMessages(messages: WireMessage[]): TemplateMessage[] {
  return messages.map((message): TemplateMessage => {
    if (message.role !== "assistant") return message;
    const out: TemplateMessage = { role: "assistant", content: message.content ?? "" };
    if (message.tool_calls?.length) {
      out.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: parseArguments(call.function.arguments) },
      }));
    }
    return out;
  });
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through and hand the model the raw text.
  }
  return { input: raw };
}

export type OutputEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> };

const THINK_END = "</think>";
const FUNCTION_START = "<function";
const FUNCTION_END = "</function>";
const PARAM_START = '<param name="';
const PARAM_END = "</param>";
const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";
const NAME_ATTR = ' name="';

/** Length of the longest suffix of `text` that could still grow into `marker`. */
function partialSuffix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

type Scan =
  | { kind: "call"; name: string; args: Record<string, string>; end: number }
  /** The buffer ends before the element does; wait for more. */
  | { kind: "incomplete" }
  /** Not a function element after all; treat the text literally. */
  | { kind: "invalid" };

const INCOMPLETE: Scan = { kind: "incomplete" };
const INVALID: Scan = { kind: "invalid" };

/** Read a quoted attribute value starting at `i`, just after the opening quote. */
function scanQuoted(s: string, i: number): { value: string; end: number } | null {
  const close = s.indexOf('"', i);
  return close < 0 ? null : { value: s.slice(i, close), end: close + 1 };
}

/**
 * Parse one `<function …>…</function>` element at the start of `s`.
 *
 * Works on a partial buffer: returns `incomplete` rather than guessing when
 * the input runs out, and `invalid` when what follows `<function` is not the
 * element at all. Values arrive either bare or as one or more CDATA sections
 * (the template splits `]]>` across two), and a value may legitimately contain
 * `</param>` inside CDATA, which is why this is a scanner and not a regex.
 */
function scanFunction(s: string): Scan {
  let i = FUNCTION_START.length;

  if (!s.startsWith(NAME_ATTR, i)) {
    return NAME_ATTR.startsWith(s.slice(i)) ? INCOMPLETE : INVALID;
  }
  i += NAME_ATTR.length;
  const name = scanQuoted(s, i);
  if (!name) return INCOMPLETE;
  i = name.end;
  if (i >= s.length) return INCOMPLETE;
  if (s[i] !== ">") return INVALID;
  i += 1;

  const args: Record<string, string> = {};
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
    if (i >= s.length) return INCOMPLETE;

    if (s.startsWith(FUNCTION_END, i)) {
      return { kind: "call", name: name.value, args, end: i + FUNCTION_END.length };
    }
    if (!s.startsWith(PARAM_START, i)) {
      const rest = s.slice(i);
      return FUNCTION_END.startsWith(rest) || PARAM_START.startsWith(rest) ? INCOMPLETE : INVALID;
    }

    i += PARAM_START.length;
    const param = scanQuoted(s, i);
    if (!param) return INCOMPLETE;
    i = param.end;
    if (i >= s.length) return INCOMPLETE;
    if (s[i] !== ">") return INVALID;
    i += 1;

    let value = "";
    const rest = s.slice(i);
    if (s.startsWith(CDATA_START, i)) {
      while (s.startsWith(CDATA_START, i)) {
        i += CDATA_START.length;
        const close = s.indexOf(CDATA_END, i);
        if (close < 0) return INCOMPLETE;
        value += s.slice(i, close);
        i = close + CDATA_END.length;
        if (CDATA_START.startsWith(s.slice(i)) && i < s.length) return INCOMPLETE;
      }
      while (i < s.length && /\s/.test(s[i]!)) i += 1;
      if (!s.startsWith(PARAM_END, i)) {
        return PARAM_END.startsWith(s.slice(i)) ? INCOMPLETE : INVALID;
      }
      i += PARAM_END.length;
    } else if (CDATA_START.startsWith(rest) && rest.length < CDATA_START.length) {
      return INCOMPLETE;
    } else {
      const close = s.indexOf(PARAM_END, i);
      if (close < 0) return INCOMPLETE;
      value = s.slice(i, close);
      i = close + PARAM_END.length;
    }
    args[param.value] = value;
  }
}

/**
 * Cast parameter strings to the types the tool's schema declares.
 *
 * The template serialises non-string values with `tojson`, so a model that
 * has learned the format sends them back the same way. Anything that fails to
 * decode is left as text rather than dropped.
 */
function coerceArguments(
  name: string,
  args: Record<string, string>,
  tools: ToolDefinition[],
): Record<string, unknown> {
  const properties = tools.find((t) => t.function.name === name)?.function.parameters?.properties;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const type = properties?.[key]?.type;
    if (type && type !== "string") {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        // Not valid JSON; the text is the best we have.
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Incremental parser for the model's output.
 *
 * With thinking enabled the generation prompt already opened a `<think>`
 * block, so everything up to `</think>` is reasoning. After that, text is
 * emitted as it arrives except for a possible partial `<function` at the end
 * of the buffer, which is held back until it either completes or turns out
 * to be ordinary text.
 */
export class OutputParser {
  private buffer = "";
  private phase: "reasoning" | "content";
  /** Drop the blank line the template leaves after `</think>`, and any after a call. */
  private trimLeading = true;
  private readonly tools: ToolDefinition[];

  constructor(options: { thinking: boolean; tools?: ToolDefinition[] }) {
    this.phase = options.thinking ? "reasoning" : "content";
    this.tools = options.tools ?? [];
  }

  /** Whether the model is still inside its `<think>` block. */
  get reasoning(): boolean {
    return this.phase === "reasoning";
  }

  push(chunk: string): OutputEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Flush whatever is held back at end of stream. */
  finish(): OutputEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): OutputEvent[] {
    const events: OutputEvent[] = [];
    for (;;) {
      if (this.phase === "reasoning") {
        const end = this.buffer.indexOf(THINK_END);
        if (end < 0) {
          const hold = final ? 0 : partialSuffix(this.buffer, THINK_END);
          const text = this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(text.length);
          if (text) events.push({ type: "reasoning", text });
          return events;
        }
        const text = this.buffer.slice(0, end);
        if (text) events.push({ type: "reasoning", text });
        this.buffer = this.buffer.slice(end + THINK_END.length);
        this.phase = "content";
        continue;
      }

      if (this.trimLeading) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        if (!this.buffer) return events;
        this.trimLeading = false;
      }

      const start = this.buffer.indexOf(FUNCTION_START);
      if (start < 0) {
        // Hold back a possible partial `<function`, and any trailing
        // whitespace: if a call follows it, it was layout rather than reply.
        let keep = final ? this.buffer.length : this.buffer.length - partialSuffix(this.buffer, FUNCTION_START);
        if (!final) {
          while (keep > 0 && /\s/.test(this.buffer[keep - 1]!)) keep -= 1;
        }
        const text = this.buffer.slice(0, keep);
        this.buffer = this.buffer.slice(keep);
        if (text) events.push({ type: "text", text });
        return events;
      }

      // What comes before `<function` is not emitted until the scan says
      // what follows it: a call, in which case the whitespace around it was
      // layout; or ordinary text, which must be passed through verbatim.
      const before = this.buffer.slice(0, start);
      const scan = scanFunction(this.buffer.slice(start));
      if (scan.kind === "incomplete") {
        if (!final) return events;
        // Stream ended mid-element: nothing to call, so show what there was.
        events.push({ type: "text", text: this.buffer });
        this.buffer = "";
        return events;
      }
      if (scan.kind === "invalid") {
        events.push({ type: "text", text: before + FUNCTION_START });
        this.buffer = this.buffer.slice(start + FUNCTION_START.length);
        continue;
      }
      const text = before.trimEnd();
      if (text) events.push({ type: "text", text });
      events.push({
        type: "tool_call",
        name: scan.name,
        arguments: coerceArguments(scan.name, scan.args, this.tools),
      });
      this.buffer = this.buffer.slice(start + scan.end);
      this.trimLeading = true;
    }
  }
}

/** One `data:` line of a `text/event-stream`. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/**
 * Builds Chat Completions chunks for one response.
 *
 * Tool calls go out whole — name and arguments in a single chunk — since the
 * XML is only parseable once complete. ofx's adapter accepts that as readily
 * as fragments.
 */
export class ChunkWriter {
  private calls = 0;

  constructor(
    private readonly id: string,
    private readonly model: string,
  ) {}

  private chunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
    return sseData({
      id: this.id,
      object: "chat.completion.chunk",
      model: this.model,
      choices: [{ index: 0, delta, finish_reason }],
    });
  }

  event(event: OutputEvent): string {
    switch (event.type) {
      case "text":
        return this.chunk({ content: event.text });
      case "reasoning":
        // DeepSeek's field name, which clients that show reasoning already
        // understand and the rest ignore.
        return this.chunk({ reasoning_content: event.text });
      case "tool_call": {
        const index = this.calls;
        this.calls += 1;
        return this.chunk({
          tool_calls: [
            {
              index,
              id: `call_${this.id}_${index}`,
              type: "function",
              function: { name: event.name, arguments: JSON.stringify(event.arguments) },
            },
          ],
        });
      }
    }
  }

  /** The closing chunks: a finish reason, then usage, then the sentinel. */
  finish(reason: "stop" | "length", usage: { promptTokens: number; completionTokens: number }): string {
    const finish_reason = this.calls > 0 ? "tool_calls" : reason;
    return (
      this.chunk({}, finish_reason) +
      sseData({
        id: this.id,
        object: "chat.completion.chunk",
        model: this.model,
        choices: [],
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens },
      }) +
      SSE_DONE
    );
  }
}
