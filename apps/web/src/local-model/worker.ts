import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import {
  CONTEXT_BUDGET,
  MODEL_BYTES,
  MODEL_ID,
  MODEL_REVISION,
  type FromWorker,
  type LoadPhase,
  type ToWorker,
} from "./protocol.js";

/**
 * Runs MiniCPM5-2B on WebGPU, off the main thread.
 *
 * Transformers.js fetches the weights from the Hub and keeps them in the
 * Cache API, so the 1.8 GiB download happens once per browser. The model's
 * own chat template renders the prompt, tools included; this file only
 * moves tokens.
 */

const post = (message: FromWorker): void => postMessage(message);

// Hugging Face refuses downloads that carry a `*.workers.dev` Referer (it
// answers with an HTML error page and no CORS headers), which is exactly where
// this app is hosted. Every request the library makes goes through `env.fetch`,
// so strip the referrer here; the Origin header still goes out and is allowed.
env.fetch = (input, init) => fetch(input, { ...init, referrerPolicy: "no-referrer" });

type TemplateOptions = NonNullable<Parameters<PreTrainedTokenizer["apply_chat_template"]>[1]>;

/** Fewer tokens than this cannot hold a tool call, let alone an answer. */
const MIN_REPLY_TOKENS = 256;

/** Special tokens the streamer emits on their own that are not part of the reply. */
const END_OF_TURN = new Set(["<|im_end|>", "</s>", "<|im_start|>"]);

let loading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;

/** The stopping criteria of the generation in flight, so it can be interrupted. */
let active: { id: number; stop: InterruptableStoppingCriteria } | null = null;

/**
 * Whether the final weight shard is already in the Cache API — a good proxy
 * for "everything is", since shards load in order. Lets the progress line
 * say "loading" rather than "downloading" on a warm start.
 */
async function isCached(): Promise<boolean> {
  try {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    return keys.some((request) => request.url.endsWith("model_q4f16.onnx_data_6"));
  } catch {
    return false;
  }
}

/** The sliver of WebGPU used here; the DOM lib does not ship its types. */
interface GpuLike {
  requestAdapter(): Promise<{ features: Set<string> } | null>;
}

async function requireWebGpu(): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  const adapter = await gpu?.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU is not available in this browser. Use a recent Chrome or Edge, or pick a hosted provider in Settings.");
  }
  if (!adapter.features.has("shader-f16")) {
    throw new Error("This GPU does not support 16-bit shaders (shader-f16), which the local model needs. Pick a hosted provider in Settings.");
  }
}

function load(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> {
  loading ??= (async () => {
    await requireWebGpu();
    const phase: LoadPhase = (await isCached()) ? "cache" : "download";

    // Per-file byte counts, summed for one bar across the shards. The total
    // is known up front from the manifest, so the bar is honest from 0%.
    const loaded = new Map<string, number>();
    let total = MODEL_BYTES;
    const report = (): void => {
      let sum = 0;
      for (const bytes of loaded.values()) sum += bytes;
      post({ type: "progress", phase, loaded: Math.min(sum, total), total });
    };
    const progress_callback = (event: {
      status: string;
      file?: string;
      loaded?: number;
      total?: number;
    }): void => {
      if (event.status !== "progress" || !event.file) return;
      loaded.set(event.file, event.loaded ?? 0);
      // The tokenizer is not in the manifest figure; grow the total if the
      // files turn out to add up to more.
      let known = 0;
      for (const bytes of loaded.values()) known += bytes;
      if (known > total) total = known;
      report();
    };

    const options = { revision: MODEL_REVISION, progress_callback };
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, options).catch((error: unknown) => {
      // The library probes for the tokenizer files and, if the probe fails,
      // reports a missing field rather than the network. Say what happened.
      throw new Error(`Could not fetch the model from Hugging Face: ${describe(error)}`);
    });
    const model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      ...options,
      dtype: "q4f16",
      device: "webgpu",
    });

    // The first call compiles the shaders, which takes seconds; better spent
    // here than on the user's first prompt.
    post({ type: "progress", phase: "compile", loaded: 0, total: 1 });
    const warmup = tokenizer("hi", { return_tensor: true });
    await model.generate({ ...warmup, max_new_tokens: 1, do_sample: false });
    post({ type: "progress", phase: "compile", loaded: 1, total: 1 });

    return { tokenizer, model };
  })();
  return loading;
}

async function generate(request: Extract<ToWorker, { type: "generate" }>): Promise<void> {
  const { id } = request;
  const { tokenizer, model } = await load();

  // `enable_thinking` is the template's own variable, passed through the
  // options object; the typings only know the standard fields.
  const options: TemplateOptions & { enable_thinking: boolean } = {
    tools: request.tools.length > 0 ? request.tools : undefined,
    add_generation_prompt: true,
    enable_thinking: request.thinking,
    tokenize: false,
  };
  const prompt = tokenizer.apply_chat_template(request.messages, options) as string;
  // The template already wrote the BOS token.
  const inputs = tokenizer(prompt, { add_special_tokens: false, return_tensor: true });
  const promptTokens = inputs.input_ids.dims[1] ?? 0;
  post({ type: "prompt", id, tokens: promptTokens });

  // The reply gets whatever the prompt left of the budget. Below a useful
  // floor there is no point running the model at all.
  const maxNewTokens = Math.min(request.maxNewTokens, CONTEXT_BUDGET - promptTokens);
  if (maxNewTokens < MIN_REPLY_TOKENS) {
    throw new Error(
      `The conversation (${promptTokens} tokens) has outgrown the local model's ` +
        `${CONTEXT_BUDGET}-token context. Use /clear to start a fresh one.`,
    );
  }

  const stop = new InterruptableStoppingCriteria();
  active = { id, stop };

  let completionTokens = 0;
  // The tool-call markup — `<function`, `<param` and their closers — is made
  // of special tokens, so skipping specials would silently delete every tool
  // call. Keep them, and drop only the end-of-turn markers by hand.
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text: string) => {
      if (text && !END_OF_TURN.has(text)) post({ type: "token", id, text });
    },
    token_callback_function: () => {
      completionTokens += 1;
    },
  });

  try {
    await model.generate({
      ...inputs,
      // The model card's sampling settings; greedy decoding makes small
      // thinking models loop.
      do_sample: true,
      temperature: 1.0,
      top_p: 0.95,
      max_new_tokens: maxNewTokens,
      streamer,
      stopping_criteria: stop,
    });
  } finally {
    if (active?.id === id) active = null;
  }

  post({
    type: "done",
    id,
    promptTokens,
    completionTokens,
    reason: completionTokens >= maxNewTokens ? "length" : "stop",
  });
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      load()
        .then(() => post({ type: "ready" }))
        .catch((error: unknown) => {
          loading = null;
          post({ type: "error", message: describe(error) });
        });
      break;
    case "generate":
      generate(message).catch((error: unknown) => {
        post({ type: "error", id: message.id, message: describe(error) });
      });
      break;
    case "interrupt":
      if (active?.id === message.id) active.stop.interrupt();
      break;
  }
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
