import { ChunkWriter, OutputParser, sseData, toTemplateMessages, type ChatRequest } from "./chat.js";
import {
  MAX_NEW_TOKENS,
  MODEL_NAME,
  type FromWorker,
  type ToWorker,
} from "./protocol.js";

export { MODEL_NAME } from "./protocol.js";

/**
 * A model that runs in the tab, presented to ofx as an OpenAI-compatible
 * endpoint.
 *
 * ofx's browser build takes a `fetch` function, so this supplies one that
 * answers `POST …/chat/completions` from a Web Worker instead of the network.
 * The core never learns the difference: it sends the same request it would
 * send to any compatible server and reads the same event stream back.
 */

/** Base URL handed to ofx. Never resolved; it only has to route here. */
export const LOCAL_BASE_URL = "local://minicpm/v1";

/**
 * Let the model reason before it answers. The template opens a `<think>`
 * block; the reasoning is streamed as `reasoning_content` so the transcript
 * stays clean but a client that wants it can show it.
 */
const THINKING = true;

export type LocalModelStatus =
  | { phase: "idle" }
  | { phase: "download" | "cache"; loaded: number; total: number }
  | { phase: "compile" }
  | { phase: "ready" }
  | { phase: "prefill"; tokens: number }
  | { phase: "generating"; tokens: number; tokensPerSecond: number; reasoning: boolean }
  | { phase: "error"; message: string };

interface Pending {
  onPrompt(tokens: number): void;
  onToken(text: string): void;
  onDone(result: { promptTokens: number; completionTokens: number; reason: "stop" | "length" }): void;
  onError(message: string): void;
}

export class LocalModel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private status: LocalModelStatus = { phase: "idle" };
  private readonly listeners = new Set<(status: LocalModelStatus) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  get current(): LocalModelStatus {
    return this.status;
  }

  /** Watch load and generation progress. The listener is called with the current status at once. */
  subscribe(listener: (status: LocalModelStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: LocalModelStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Start the worker and load the weights. Idempotent; a failure clears the
   * attempt so the next call can retry.
   */
  load(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.post({ type: "load" });
    });
    return this.ready;
  }

  private post(message: ToWorker): void {
    this.worker ??= this.spawn();
    this.worker.postMessage(message);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      this.fail(event.message || "the model worker crashed");
    };
    return worker;
  }

  private fail(message: string): void {
    this.setStatus({ phase: "error", message });
    this.rejectReady?.(new Error(message));
    this.ready = null;
    this.resolveReady = null;
    this.rejectReady = null;
    for (const request of this.pending.values()) request.onError(message);
    this.pending.clear();
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "progress":
        this.setStatus(
          message.phase === "compile"
            ? { phase: "compile" }
            : { phase: message.phase, loaded: message.loaded, total: message.total },
        );
        break;
      case "ready":
        this.setStatus({ phase: "ready" });
        this.resolveReady?.();
        break;
      case "prompt":
        this.pending.get(message.id)?.onPrompt(message.tokens);
        break;
      case "token":
        this.pending.get(message.id)?.onToken(message.text);
        break;
      case "done":
        this.pending.get(message.id)?.onDone(message);
        break;
      case "error":
        if (message.id === undefined) {
          this.fail(message.message);
        } else {
          this.pending.get(message.id)?.onError(message.message);
        }
        break;
    }
  }

  /**
   * A `fetch` for ofx. Only `POST …/chat/completions` is served; anything
   * else gets a 404 so a misrouted request fails loudly.
   */
  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.endsWith("/chat/completions") || init?.method !== "POST") {
      return new Response(`the local model serves only chat completions, not ${url}`, { status: 404 });
    }
    const request = JSON.parse(String(init.body)) as ChatRequest;
    const signal = init.signal ?? undefined;

    try {
      await this.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 503 });
    }
    if (signal?.aborted) throw abortError();

    const id = this.nextId;
    this.nextId += 1;
    const tools = request.tools ?? [];
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const writer = new ChunkWriter(`local-${id}`, request.model ?? MODEL_NAME);
        const parser = new OutputParser({ thinking: THINKING, tools });
        const write = (text: string): void => controller.enqueue(encoder.encode(text));

        let tokens = 0;
        let firstToken = 0;
        const finish = (): void => {
          this.pending.delete(id);
          signal?.removeEventListener("abort", abort);
          this.setStatus({ phase: "ready" });
        };
        const abort = (): void => {
          this.post({ type: "interrupt", id });
          finish();
          controller.error(abortError());
        };

        this.pending.set(id, {
          onPrompt: (count) => this.setStatus({ phase: "prefill", tokens: count }),
          onToken: (text) => {
            tokens += 1;
            firstToken ||= performance.now();
            const elapsed = (performance.now() - firstToken) / 1000;
            for (const event of parser.push(text)) write(writer.event(event));
            this.setStatus({
              phase: "generating",
              tokens,
              tokensPerSecond: elapsed > 0.5 ? (tokens - 1) / elapsed : 0,
              reasoning: parser.reasoning,
            });
          },
          onDone: (result) => {
            for (const event of parser.finish()) write(writer.event(event));
            write(writer.finish(result.reason, result));
            finish();
            controller.close();
          },
          onError: (message) => {
            // In-band, the way a server reports a failure mid-stream; ofx's
            // adapter turns it into an error the terminal prints.
            write(sseData({ error: { message } }));
            finish();
            controller.close();
          },
        });
        signal?.addEventListener("abort", abort, { once: true });

        this.post({
          type: "generate",
          id,
          messages: toTemplateMessages(request.messages),
          tools,
          maxNewTokens: Math.min(request.max_tokens ?? MAX_NEW_TOKENS, MAX_NEW_TOKENS),
          thinking: THINKING,
        });
      },
      cancel: () => {
        if (this.pending.has(id)) {
          this.post({ type: "interrupt", id });
          this.pending.delete(id);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function abortError(): DOMException {
  return new DOMException("The model request was aborted.", "AbortError");
}

/** One model per tab: the weights are far too large to load twice. */
export const localModel = new LocalModel();
