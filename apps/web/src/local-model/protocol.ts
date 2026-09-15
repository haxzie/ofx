/**
 * The local model, and the messages exchanged with the worker that runs it.
 *
 * Inference happens off the main thread so the terminal stays responsive
 * while the GPU is busy. The main thread only ever sees text: the worker
 * streams decoded tokens, and the parsing of tool calls out of that text is
 * done by `chat.ts` on this side, where it can be tested without a GPU.
 */

/** The int4 ONNX conversion of MiniCPM5-2B, prepared for WebGPU. */
export const MODEL_ID = "Mike0021/MiniCPM5-2B-ONNX";
/** Pinned so a repository update cannot change the model under a session. */
export const MODEL_REVISION = "04a6c49fcba3a65a0351c92644c3a7e9d4343059";
/** The model id users see. */
export const MODEL_NAME = "minicpm5-2b";
/** Sum of the weight shards, from the repository manifest — the denominator for the progress bar. */
export const MODEL_BYTES = 1_834_167_351;

/**
 * Tokens the prompt and the reply may share. The KV cache costs about 43 KiB
 * per token in fp16, so this keeps a whole turn under half a gigabyte of GPU
 * memory on top of the weights.
 */
export const CONTEXT_BUDGET = 8192;
/** Cap on one model call; the remainder of the budget goes to the prompt. */
export const MAX_NEW_TOKENS = 2048;

/** A message in the shape the model's chat template consumes. */
export type TemplateMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: Record<string, unknown> } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** A tool as OpenAI Chat Completions advertises it. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: { type?: string; properties?: Record<string, { type?: string }>; required?: string[] };
  };
}

export type ToWorker =
  | { type: "load" }
  | {
      type: "generate";
      id: number;
      messages: TemplateMessage[];
      tools: ToolDefinition[];
      maxNewTokens: number;
      thinking: boolean;
    }
  | { type: "interrupt"; id: number };

export type LoadPhase = "download" | "cache" | "compile";

export type FromWorker =
  | { type: "progress"; phase: LoadPhase; loaded: number; total: number }
  | { type: "ready" }
  | { type: "prompt"; id: number; tokens: number }
  | { type: "token"; id: number; text: string }
  | { type: "done"; id: number; promptTokens: number; completionTokens: number; reason: "stop" | "length" }
  | { type: "error"; id?: number; message: string };
