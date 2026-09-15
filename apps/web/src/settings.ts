import { createStore, get, set } from "idb-keyval";
import { MODEL_NAME as LOCAL_MODEL } from "./local-model/protocol.js";

export interface Settings {
  /** `local` runs MiniCPM5-2B in the tab on WebGPU; the rest are hosted APIs. */
  provider: "local" | "anthropic" | "openai" | "gemini" | "moonshot" | "glm";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The local model has nothing to authenticate against. */
export function needsApiKey(provider: Settings["provider"]): boolean {
  return provider !== "local";
}

/**
 * This deployment's own git proxy. Relative, so it follows the origin.
 * Not user-configurable: it is the only endpoint that carries the signed-in
 * user's credentials.
 */
export const GIT_PROXY = "/api/git";

/**
 * Out of the box the agent runs on the local model, so a first visit works
 * without a key. Hosted providers are opt-in from Settings.
 */
export const DEFAULT_SETTINGS: Settings = {
  provider: "local",
  baseUrl: "",
  apiKey: "",
  model: LOCAL_MODEL,
};

// Not renamed with the rest of the branding — see the note in workspace.ts.
// Changing this database name would silently discard saved settings.
const store = createStore("wowsm-settings", "settings");
const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await get<Partial<Settings>>(KEY, store);
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    // A hosted provider with no key cannot run at all — settings saved before
    // the local model existed look like this. Fall back to what can.
    if (needsApiKey(settings.provider) && !settings.apiKey) return { ...DEFAULT_SETTINGS };
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(KEY, settings, store);
}

/** Commit identity when signed out. Signing in replaces it with the account's. */
export const ANONYMOUS_IDENTITY = { name: "OFX User", email: "user@ofx.local" } as const;

/** Commit identity for the current session. */
export function identityFor(
  user: { name?: string | null; email?: string | null } | null,
): { name: string; email: string } {
  return {
    name: user?.name || ANONYMOUS_IDENTITY.name,
    email: user?.email || ANONYMOUS_IDENTITY.email,
  };
}
