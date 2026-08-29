import type { Workspace } from "@wowsm/git";
import type { Settings } from "./settings.js";

/** The shape ofx-wasm expects of a workspace. */
export interface OfxWorkspace {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  glob(pattern: string): Promise<string[]>;
  readonly cwd: string;
}

/** Events the agent streams back, mirroring `AgentEvent` in ofx-core. */
export type OfxEvent =
  | { type: "textDelta"; text: string }
  | { type: "toolStart"; id: string; name: string; input: Record<string, unknown> }
  | { type: "toolEnd"; id: string; name: string; output: string; isError: boolean }
  | { type: "stepComplete"; usage: { inputTokens: number; outputTokens: number } }
  | {
      type: "turnComplete";
      stop: string;
      usage: { inputTokens: number; outputTokens: number };
    };

/**
 * Translate a glob to a regular expression.
 *
 * `**` crosses directory separators, `*` and `?` do not — the usual shell
 * semantics. just-bash bundles minimatch but does not export it, so this is a
 * small local implementation over the flat path list the VFS already keeps.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero directories.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Expose the browser workspace to ofx.
 *
 * `exec` routes to just-bash, which has just-git registered as a command — so
 * the agent gets a working `git` with no special support, unlike fx's browser
 * build, whose workspace contract forbids advertising git at all.
 */
export function createOfxWorkspace(workspace: Workspace): OfxWorkspace {
  const { fs, shell, root } = workspace;

  const absolute = (path: string): string =>
    path.startsWith("/") ? path : fs.resolvePath(shell.cwd, path);

  return {
    async exec(command) {
      const result = await shell.run(command);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },

    readFile: (path) => fs.readFile(absolute(path)),

    writeFile: async (path, contents) => {
      await fs.writeFile(absolute(path), contents);
    },

    async listDir(path) {
      const dir = absolute(path);
      const entries = await fs.readdirWithFileTypes(dir);
      return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).sort();
    },

    async glob(pattern) {
      const base = pattern.startsWith("/") ? "" : `${root}/`;
      const matcher = globToRegExp(`${base}${pattern}`);
      return fs
        .getAllPaths()
        .filter((p) => !p.includes("/.git/") && matcher.test(p))
        .map((p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p));
    },

    get cwd() {
      return shell.cwd;
    },
  };
}

type OfxModule = typeof import("ofx-wasm");
let modulePromise: Promise<OfxModule> | null = null;

/** Load and initialise the wasm module once. */
async function loadOfx(): Promise<OfxModule> {
  modulePromise ??= (async () => {
    const module = await import("ofx-wasm");
    await module.default();
    return module;
  })();
  return modulePromise;
}

export interface OfxAgentHandle {
  /** Aborting `signal` cancels the in-flight model request. */
  runTurn(
    prompt: string,
    onEvent: (event: OfxEvent) => void,
    signal?: AbortSignal,
  ): Promise<unknown>;
  clear(): void;
}

/**
 * Build an agent for the current settings. Returns null when no API key is
 * configured, which the caller reports rather than failing opaquely.
 */
export async function createOfxAgent(
  settings: Settings,
  workspace: Workspace,
): Promise<OfxAgentHandle | null> {
  if (!settings.apiKey) return null;
  const { OfxAgent } = await loadOfx();

  return new OfxAgent(
    {
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      maxTokens: 8192,
      maxSteps: 40,
      // The model only knows about git unless the host says otherwise, so it
      // would decline to reach for gh or curl without this.
      workspaceTools:
        "a POSIX shell (grep, sed, awk, find, jq, rg), git, " +
        "gh (the GitHub CLI: api, auth, pr, issue, repo), and curl. " +
        "curl runs in a browser, so it can only reach hosts that send " +
        "Access-Control-Allow-Origin. gh and git are authenticated when the " +
        "user is signed in; otherwise they act anonymously on public data.",
    },
    createOfxWorkspace(workspace) as never,
  ) as unknown as OfxAgentHandle;
}
