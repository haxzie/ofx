import { createStore, get, set } from "idb-keyval";

export interface Settings {
  /** Git author identity used for commits made in the browser. */
  gitName: string;
  gitEmail: string;
  /** Model provider config, consumed by the agent in a later milestone. */
  provider: "anthropic" | "openai" | "gemini" | "moonshot" | "glm";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * This deployment's own git proxy. Relative, so it follows the origin.
 * Not user-configurable: it is the only endpoint that carries the signed-in
 * user's credentials.
 */
export const GIT_PROXY = "/api/git";

export const DEFAULT_SETTINGS: Settings = {
  gitName: "Browser User",
  gitEmail: "user@ofx.local",
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
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(KEY, settings, store);
}
