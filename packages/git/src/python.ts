import type { CustomCommand } from "just-bash/browser";

/** Pinned so a CDN update cannot change the interpreter under a session. */
const PYODIDE_VERSION = "314.0.6";
const DEFAULT_INDEX_URL = `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;

export interface PythonOptions {
  /** Where to fetch Pyodide from. Must end with a slash. */
  indexUrl?: string;
  /** Called once, before the first (large) download begins. */
  onProgress?: (message: string) => void;
  /** Injected by tests in place of the real runtime. */
  loadRuntime?: () => Promise<PyodideRuntime>;
}

/** The slice of Pyodide's API this uses. */
export interface PyodideRuntime {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const USAGE = `python: runs CPython in the browser via Pyodide.

  python -c 'print(1 + 1)'
  echo 'print("hi")' | python

Only -c and piped stdin are supported. There is no filesystem access: the
interpreter cannot see the workspace, so a script file cannot be run and
open() will not find repository files. Use the shell for anything touching
files, or run python from the installed ofx CLI, which has your real one.`;

/**
 * `python` for the browser shell.
 *
 * just-bash ships a python for Node but deliberately stubs it out in the
 * browser, so this supplies one. Pyodide is roughly 11 MiB, which is why it is
 * fetched on first use rather than at startup — an app that never runs python
 * never pays for it.
 *
 * The interpreter is deliberately isolated from the workspace: bridging its
 * Emscripten filesystem to the VFS is a much larger piece of work, and a
 * half-working `open()` would be worse than an honest refusal.
 */
export function createPythonCommand(options: PythonOptions = {}): CustomCommand {
  const indexUrl = options.indexUrl ?? DEFAULT_INDEX_URL;
  let runtime: Promise<PyodideRuntime> | null = null;

  const load = (): Promise<PyodideRuntime> => {
    runtime ??= (async () => {
      options.onProgress?.(
        "Downloading Python (Pyodide, ~11 MiB). This happens once; the browser caches it.\n",
      );
      if (options.loadRuntime) return options.loadRuntime();

      // @vite-ignore keeps the bundler from trying to resolve a remote URL.
      const module = (await import(/* @vite-ignore */ `${indexUrl}pyodide.mjs`)) as {
        loadPyodide: (config: { indexURL: string }) => Promise<PyodideRuntime>;
      };
      return module.loadPyodide({ indexURL: indexUrl });
    })();
    return runtime;
  };

  return {
    name: "python",
    async execute(argv: string[], ctx: unknown): Promise<Result> {
      const context = ctx as { stdin?: unknown };

      if (argv.includes("--help") || argv.includes("-h")) {
        return { stdout: `${USAGE}\n`, stderr: "", exitCode: 0 };
      }
      if (argv.includes("--version") || argv.includes("-V")) {
        return { stdout: `Python (Pyodide ${PYODIDE_VERSION})\n`, stderr: "", exitCode: 0 };
      }

      let code: string | null = null;
      const dashC = argv.indexOf("-c");
      if (dashC !== -1) {
        code = argv[dashC + 1] ?? "";
      } else {
        const script = argv.find((a) => !a.startsWith("-"));
        if (script) {
          return {
            stdout: "",
            stderr:
              `python: cannot run ${script}: this interpreter has no access to the ` +
              `workspace filesystem. Pass the code with -c, or pipe it in.\n`,
            exitCode: 2,
          };
        }
        // No -c and no script: read the program from stdin, as python does.
        const stdin = context.stdin;
        const piped = typeof stdin === "string" ? stdin : "";
        if (piped.trim() === "") {
          return { stdout: "", stderr: `${USAGE}\n`, exitCode: 2 };
        }
        code = piped;
      }

      let out = "";
      let err = "";
      try {
        const py = await load();
        py.setStdout({ batched: (text) => (out += text) });
        py.setStderr({ batched: (text) => (err += text) });
        await py.runPythonAsync(code);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Pyodide puts the Python traceback in the error message.
        return { stdout: out, stderr: err + message.replace(/\s*$/, "") + "\n", exitCode: 1 };
      }

      // Pyodide's batched writers omit the trailing newline print() emits.
      const normalize = (text: string): string =>
        text === "" || text.endsWith("\n") ? text : `${text}\n`;
      return { stdout: normalize(out), stderr: normalize(err), exitCode: 0 };
    },
  } as unknown as CustomCommand;
}
