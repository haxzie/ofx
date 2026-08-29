import { createWorkspace, type Workspace } from "@wowsm/git";
import { getGitToken } from "./auth.js";
import { GIT_PROXY, identityFor, type Settings } from "./settings.js";
import type { SessionUser } from "./auth.js";

export type { Workspace };

/**
 * Build the workspace from current settings. Token and proxy are read through
 * getters, so edits in the settings dialog apply to the next command without
 * rebuilding anything.
 */
export function bootWorkspace(
  getSettings: () => Settings,
  user: SessionUser | null,
): Promise<Workspace> {
  return createWorkspace({
    // Deliberately not renamed with the rest of the branding: this is the
    // IndexedDB database name, and changing it orphans every existing
    // workspace. A rename needs a migration, not a find-and-replace.
    fs: { dbName: "wowsm-vfs" },
    // Fallback only: `git config user.name` in the repo wins, and App syncs it
    // whenever the session changes.
    identity: identityFor(user),
    // The JWT is exchanged for a real GitHub token inside the proxy, so no
    // credential is ever held in the page. Null when signed out, which the
    // proxy treats as anonymous.
    token: async () => (await getGitToken()) ?? undefined,
    // The credential is a session JWT bound for this app's own proxy, not a
    // GitHub token, so it goes as Bearer — which is what the proxy reads.
    authScheme: "bearer",
    corsProxy: GIT_PROXY,
    onProgress: (message) => {
      window.dispatchEvent(new CustomEvent("ofx:progress", { detail: message }));
    },
    python: {
      // The first run fetches ~11 MiB; without a notice the terminal just
      // appears to hang.
      onProgress: (message) => {
        window.dispatchEvent(new CustomEvent("ofx:progress", { detail: message }));
      },
    },
  });
}
