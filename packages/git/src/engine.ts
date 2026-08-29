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
  /** Override the network policy entirely. Used by tests. */
  network?: { fetch: typeof fetch };
}

/**
 * Wire up just-git against a filesystem, with credentials and CORS proxying
 * resolved lazily so settings changes take effect without a rebuild.
 */
/**
 * The same filesystem with `symlink` withheld.
 *
 * just-git refuses to check out any symlink whose target contains `..`, even
 * when it resolves inside the repository — a common shape in monorepos, and
 * enough to abort a clone of e.g. supabase/supabase-js. The guard is pure
 * string matching that runs before `fs.symlink` is called, so it cannot be
 * satisfied from our side.
 *
 * Without a `symlink` method, just-git writes the link target as file content
 * instead. That is precisely what git itself does on filesystems that lack
 * symlink support (`core.symlinks=false`), so it is a well-trodden fallback
 * rather than an invention. The shell keeps the unmodified filesystem, so
 * `ln -s` still creates real links.
 */
export function withoutSymlinks(fs: IFileSystem): IFileSystem {
  const delegate: IFileSystem = {
    readFile: (p, o) => fs.readFile(p, o),
    readFileBuffer: (p) => fs.readFileBuffer(p),
    writeFile: (p, c, o) => fs.writeFile(p, c, o),
    appendFile: (p, c, o) => fs.appendFile(p, c, o),
    exists: (p) => fs.exists(p),
    stat: (p) => fs.stat(p),
    lstat: (p) => fs.lstat(p),
    mkdir: (p, o) => fs.mkdir(p, o),
    readdir: (p) => fs.readdir(p),
    rm: (p, o) => fs.rm(p, o),
    cp: (s, d, o) => fs.cp(s, d, o),
    mv: (s, d) => fs.mv(s, d),
    resolvePath: (b, p) => fs.resolvePath(b, p),
    getAllPaths: () => fs.getAllPaths(),
    chmod: (p, m) => fs.chmod(p, m),
    link: (a, b) => fs.link(a, b),
    readlink: (p) => fs.readlink(p),
    realpath: (p) => fs.realpath(p),
    utimes: (p, a, m) => fs.utimes(p, a, m),
  } as IFileSystem;

  // Both are optional on the interface, so they are forwarded only when the
  // underlying filesystem actually implements them.
  if (fs.readFileBytes) delegate.readFileBytes = (p) => fs.readFileBytes!(p);
  if (fs.readdirWithFileTypes) {
    delegate.readdirWithFileTypes = (p) => fs.readdirWithFileTypes!(p);
  }

  // Deliberately absent: `symlink`.
  return delegate;
}

export function createGitEngine(options: GitEngineOptions): Git {
  const {
    fs,
    cwd = DEFAULT_WORKSPACE,
    identity,
    token,
    authScheme = "basic",
    corsProxy: proxyUrl = DEFAULT_CORS_PROXY,
    onProgress,
    network: networkOverride,
  } = options;

  const resolveToken = typeof token === "function" ? token : () => token;
  const resolveProxy = typeof proxyUrl === "function" ? proxyUrl : () => proxyUrl;

  return createGit({
    fs: withoutSymlinks(fs),
    cwd,
    identity,
    onProgress,
    network: networkOverride ?? {
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
