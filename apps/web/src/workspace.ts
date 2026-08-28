import { createWorkspace, type Workspace } from "@wowsm/git";
import type { Settings } from "./settings.js";

export type { Workspace };

/**
 * Build the workspace from current settings. Token and proxy are read through
 * getters, so edits in the settings dialog apply to the next command without
 * rebuilding anything.
 */
export function bootWorkspace(getSettings: () => Settings): Promise<Workspace> {
  return createWorkspace({
    // Deliberately not renamed with the rest of the branding: this is the
    // IndexedDB database name, and changing it orphans every existing
    // workspace. A rename needs a migration, not a find-and-replace.
    fs: { dbName: "wowsm-vfs" },
    // Fallback identity only — `git config user.name` in the repo wins, and the
    // settings dialog writes there when it changes.
    identity: { name: getSettings().gitName, email: getSettings().gitEmail },
    token: () => getSettings().githubToken || undefined,
    corsProxy: () => getSettings().corsProxy,
    onProgress: (message) => {
      window.dispatchEvent(new CustomEvent("ofx:progress", { detail: message }));
    },
  });
}
