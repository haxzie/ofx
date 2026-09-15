import { useEffect, useState } from "react";
import { localModel, type LocalModelStatus } from "../local-model/index.js";

/** Follow the local model's status from React. */
export function useLocalModelStatus(): LocalModelStatus {
  const [status, setStatus] = useState<LocalModelStatus>(localModel.current);
  useEffect(() => localModel.subscribe(setStatus), []);
  return status;
}

const mib = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MiB`;

/**
 * Where the local model is, shown in the header so the download is visible
 * from the moment the page opens rather than only once a prompt is sent.
 *
 * Progress is drawn twice: a percentage in the label, and a hairline across
 * the bottom of the header that fills left to right — readable at a glance
 * from the terminal without focusing on the text.
 */
export function ModelProgress({ onError }: { onError: () => void }): React.JSX.Element | null {
  const status = useLocalModelStatus();

  let label: string;
  let fraction: number | null = null;
  let tone: "busy" | "ready" | "error" = "busy";

  switch (status.phase) {
    case "idle":
      return null;
    case "download":
      fraction = status.loaded / status.total;
      label = `Downloading model · ${mib(status.loaded)} of ${mib(status.total)}`;
      break;
    case "cache":
      fraction = status.loaded / status.total;
      label = "Loading model from cache";
      break;
    case "compile":
      label = "Compiling shaders";
      break;
    case "ready":
      tone = "ready";
      label = "Model ready";
      break;
    case "prefill":
      label = `Reading ${status.tokens.toLocaleString()} tokens`;
      break;
    case "generating":
      label = status.tokensPerSecond > 0 ? `${status.tokensPerSecond.toFixed(0)} tok/s` : "Generating";
      break;
    case "error":
      tone = "error";
      label = status.message;
      break;
  }

  const body = (
    <>
      <span className={`model-dot ${tone}`} />
      <span className="model-label">{label}</span>
      {fraction !== null && <span className="model-pct">{Math.floor(fraction * 100)}%</span>}
      {fraction !== null && (
        <span className="model-bar" style={{ width: `${Math.max(0.5, fraction * 100)}%` }} />
      )}
    </>
  );

  return tone === "error" ? (
    <button type="button" className={`model-progress ${tone}`} onClick={onError} title={label}>
      {body}
    </button>
  ) : (
    <span className={`model-progress ${tone}`} title={label}>
      {body}
    </span>
  );
}
