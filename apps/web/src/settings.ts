import { createStore, get, set } from "idb-keyval";

export interface Settings {
  /** Git author identity used for commits made in the browser. */
  gitName: string;
  gitEmail: string;
  /** Personal access token — required for private clones and any push. */
  githubToken: string;
  corsProxy: string;
  /** Model provider config, consumed by the agent in a later milestone. */
  provider: "anthropic" | "openai" | "gemini" | "moonshot" | "glm" | "custom";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** This deployment's own git proxy. Relative, so it follows the origin. */
export const DEFAULT_PROXY = "/api/git";

/** The public proxy used before this app had one of its own. */
const LEGACY_PROXY = "https://cors.isomorphic-git.org";

export const DEFAULT_SETTINGS: Settings = {
  gitName: "Browser User",
  gitEmail: "user@ofx.local",
  githubToken: "",
  corsProxy: DEFAULT_PROXY,
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "",
  model: "claude-sonnet-5",
};

// Not renamed with the rest of the branding — see the note in workspace.ts.
// Changing this database name would silently discard saved settings.
const store = createStore("wowsm-settings", "settings");
const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await get<Partial<Settings>>(KEY, store);
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    // Move anyone still pointing at the third-party proxy onto ours, which
    // also carries their credentials when signed in.
    if (settings.corsProxy === LEGACY_PROXY) settings.corsProxy = DEFAULT_PROXY;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(KEY, settings, store);
}
