import { createStore, get, set } from "idb-keyval";

export interface Settings {
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
