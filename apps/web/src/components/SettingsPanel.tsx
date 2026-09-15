import { useEffect, useState } from "react";
import type { SessionUser } from "../auth.js";
import { GitHubIcon, SignOutIcon } from "./Icons.js";
import { ProviderIcon } from "./ProviderIcon.js";
import { Select } from "./Select.js";
import type { Settings } from "../settings.js";

export interface SettingsPanelProps {
  settings: Settings;
  user: SessionUser | null;
  onSave: (settings: Settings) => void;
  onReset: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

interface Provider {
  value: Settings["provider"];
  label: string;
  baseUrl: string;
  models: string[];
}

/**
 * Base URLs are derived from the provider rather than asked for. Model lists
 * are a starting point, not a constraint — providers ship new ids constantly,
 * so "Custom…" always allows typing one.
 */
const PROVIDERS: Provider[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
  {
    value: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini"],
  },
  {
    value: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    value: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    models: ["kimi-k2", "kimi-k2-turbo"],
  },
  {
    value: "glm",
    label: "GLM / Zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6", "glm-4.5-air"],
  },
];

const CUSTOM_MODEL = "__custom__";

/** Moonshot serves no CORS headers, so a browser cannot reach it directly. */
const NO_BROWSER_CORS: Settings["provider"][] = ["moonshot"];

export function SettingsPanel({
  settings,
  user,
  onSave,
  onReset,
  onSignIn,
  onSignOut,
}: SettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<Settings>(settings);

  // Keep the form in step when settings change elsewhere (a reset, say).
  useEffect(() => setDraft(settings), [settings]);

  // Autosave. Debounced so typing a key does not write on every keystroke, and
  // guarded by a comparison so echoing saved settings back cannot loop.
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(settings)) return;
    const timer = setTimeout(() => onSave(draft), 400);
    return () => clearTimeout(timer);
  }, [draft, settings, onSave]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const provider = PROVIDERS.find((p) => p.value === draft.provider) ?? PROVIDERS[0]!;
  // A model that is not in the list is one the user typed.
  const [customModel, setCustomModel] = useState(!provider.models.includes(settings.model));

  const selectProvider = (value: Settings["provider"]): void => {
    const preset = PROVIDERS.find((p) => p.value === value) ?? PROVIDERS[0]!;
    setCustomModel(false);
    setDraft((prev) => ({
      ...prev,
      provider: value,
      // Derived, never asked for.
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? prev.model,
    }));
  };

  const selectModel = (value: string): void => {
    if (value === CUSTOM_MODEL) {
      setCustomModel(true);
      return;
    }
    setCustomModel(false);
    update("model", value);
  };


  return (
    <div className="settings">
      <section>
        <h3>GitHub</h3>
        {user ? (
          <>
            <div className="account-row">
              {user.image ? (
                <img src={user.image} alt="" width={28} height={28} />
              ) : (
                <GitHubIcon />
              )}
              <div className="account-meta">
                <strong>{user.name}</strong>
                <span>{user.email}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={onSignOut}
                aria-label="Sign out"
                title="Sign out"
              >
                <SignOutIcon />
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              Public repositories clone without signing in. Sign in to reach private
              repositories and to push.
            </p>
            <button type="button" className="signin" onClick={onSignIn}>
              <GitHubIcon />
              <span>Sign in with GitHub</span>
            </button>
          </>
        )}
      </section>

      <section>
        <h3>Model provider</h3>
        <p className="hint">
          Your key is stored in this browser and sent straight to the provider.
        </p>
        <div className="field-row">
          <label>
            Provider
            <Select
              ariaLabel="Model provider"
              value={draft.provider}
              onChange={(value) => selectProvider(value as Settings["provider"])}
              options={PROVIDERS.map((p) => ({
                value: p.value,
                label: p.label,
                icon: <ProviderIcon provider={p.value} />,
              }))}
            />
          </label>
          <label>
            Model
            <Select
              ariaLabel="Model"
              value={customModel ? CUSTOM_MODEL : draft.model}
              onChange={selectModel}
              options={[
                ...provider.models.map((model) => ({ value: model, label: model })),
                { value: CUSTOM_MODEL, label: "Custom…" },
              ]}
            />
          </label>
        </div>
        {NO_BROWSER_CORS.includes(draft.provider) && (
          <p className="warn">
            This provider sends no CORS headers, so calls from a browser will fail. It needs a proxy.
          </p>
        )}
        {customModel && (
          <label>
            Model id
            <input
              value={draft.model}
              placeholder="provider's model id"
              onChange={(e) => update("model", e.target.value)}
            />
          </label>
        )}
        <label>
          API key
          <input type="password" value={draft.apiKey} onChange={(e) => update("apiKey", e.target.value)} />
        </label>
      </section>

      <div className="settings-actions">
        <button type="button" className="danger" onClick={onReset}>
          Reset workspace
        </button>
      </div>
    </div>
  );
}
