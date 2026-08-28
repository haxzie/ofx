import { useState } from "react";
import type { Settings } from "../settings.js";

export interface SettingsDialogProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onReset: () => void;
}

const PROVIDERS: { value: Settings["provider"]; label: string; baseUrl: string; model: string }[] = [
  { value: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
  { value: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-pro" },
  { value: "moonshot", label: "Moonshot / Kimi", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k2" },
  { value: "glm", label: "GLM / Zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { value: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", model: "" },
];

export function SettingsDialog({ settings, onSave, onClose, onReset }: SettingsDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<Settings>(settings);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const selectProvider = (value: Settings["provider"]): void => {
    const preset = PROVIDERS.find((p) => p.value === value);
    setDraft((prev) => ({
      ...prev,
      provider: value,
      baseUrl: preset?.baseUrl ?? prev.baseUrl,
      model: preset?.model || prev.model,
    }));
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section>
          <h3>Git identity</h3>
          <p className="hint">Author on commits made in this browser.</p>
          <label>
            Name
            <input value={draft.gitName} onChange={(e) => update("gitName", e.target.value)} />
          </label>
          <label>
            Email
            <input value={draft.gitEmail} onChange={(e) => update("gitEmail", e.target.value)} />
          </label>
        </section>

        <section>
          <h3>Remotes</h3>
          <p className="hint">
            Browsers cannot reach GitHub&apos;s git endpoints directly — CORS blocks the preflight — so traffic
            goes through a proxy. A token is required for private repos and for any push.
          </p>
          <label>
            CORS proxy
            <input value={draft.corsProxy} onChange={(e) => update("corsProxy", e.target.value)} />
          </label>
          <label>
            GitHub token
            <input
              type="password"
              placeholder="ghp_…"
              value={draft.githubToken}
              onChange={(e) => update("githubToken", e.target.value)}
            />
          </label>
        </section>

        <section>
          <h3>Model provider</h3>
          <p className="hint">Used by the agent. Stored in this browser only and sent straight to the provider.</p>
          <label>
            Provider
            <select
              value={draft.provider}
              onChange={(e) => selectProvider(e.target.value as Settings["provider"])}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input value={draft.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} />
          </label>
          <label>
            Model
            <input value={draft.model} onChange={(e) => update("model", e.target.value)} />
          </label>
          <label>
            API key
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
            />
          </label>
        </section>

        <footer>
          <button type="button" className="danger" onClick={onReset}>
            Reset workspace
          </button>
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
