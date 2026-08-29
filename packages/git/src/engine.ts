import { createGit, type Git } from "just-git";
import { corsProxy } from "just-git/proxy";
import type { IFileSystem } from "just-bash/browser";

/**
 * Browsers cannot talk to GitHub's smart-HTTP endpoints directly — GitHub
 * rejects the CORS preflight with a 405 — so clone/fetch/push are routed
 * through a proxy that adds the CORS headers and forwards `Authorization`.
 *
 * Verified working with just-git's URL scheme (`{proxy}/github.com/user/repo`).
 */
export const DEFAULT_CORS_PROXY = "https://cors.isomorphic-git.org";

export const DEFAULT_WORKSPACE = "/workspace";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitEngineOptions {
  fs: IFileSystem;
  /** Repo root. Set so every `exec` finds `.git` without an explicit cwd. */
  cwd?: string;
  identity?: GitIdentity;
  /**
   * Personal access token for private repos and push. Resolved on every
   * request, so the settings UI can update it without rebuilding the engine.
   */
  token?:
    | string
    | (() => string | undefined | null | Promise<string | undefined | null>);
  /**
   * `basic` sends the token as the password, which is what GitHub expects for
   * classic and fine-grained PATs. `bearer` suits GitHub App installation
   * tokens and most non-GitHub hosts.
   */
  authScheme?: "basic" | "bearer";
  /**
   * Proxy base URL. Pass `null` to talk to the remote directly (Node, tests).
   * A function is re-read on every request, so the settings UI can change the
   * proxy without rebuilding the engine.
   */
  corsProxy?: string | null | (() => string | null);
  /** Sideband progress from the remote during clone/fetch/push. */
  onProgress?: (message: string) => void;
}

/**
 * Wire up just-git against a filesystem, with credentials and CORS proxying
 * resolved lazily so settings changes take effect without a rebuild.
 */
export function createGitEngine(options: GitEngineOptions): Git {
  const {
    fs,
    cwd = DEFAULT_WORKSPACE,
    identity,
    token,
    authScheme = "basic",
    corsProxy: proxyUrl = DEFAULT_CORS_PROXY,
    onProgress,
  } = options;

  const resolveToken = typeof token === "function" ? token : () => token;
  const resolveProxy = typeof proxyUrl === "function" ? proxyUrl : () => proxyUrl;

  return createGit({
    fs,
    cwd,
    identity,
    onProgress,
    network: {
      // Resolved per request rather than captured, so changing the proxy in
      // settings takes effect immediately. `corsProxy` only builds a closure
      // that rewrites the URL, so calling it here is cheap.
      fetch: (input, init) => {
        const base = resolveProxy();
        if (base === null) return globalThis.fetch(input, init);
        const policy = corsProxy(base);
        return policy.fetch ? policy.fetch(input, init) : globalThis.fetch(input, init);
      },
    },
    credentials: async () => {
      const value = await resolveToken();
      if (!value) return null;
      return authScheme === "bearer"
        ? { type: "bearer", token: value }
        : { type: "basic", username: "x-access-token", password: value };
    },
  });
}
