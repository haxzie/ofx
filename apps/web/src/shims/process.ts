/**
 * just-bash's browser build references `process` outside of `typeof` guards
 * (vercel-labs/just-bash#111), which throws a ReferenceError in the browser.
 *
 * This lives in its own module and is imported first in `main.tsx`: ES module
 * imports are evaluated in order but hoisted above statements, so a bare
 * assignment inside `main.tsx` would run *after* just-bash had already loaded.
 */
const globals = globalThis as unknown as { process?: unknown };

globals.process ??= {
  env: {} as Record<string, string>,
  cwd: () => "/",
  platform: "browser",
  version: "",
  argv: [] as string[],
  nextTick: (fn: () => void) => queueMicrotask(fn),
};

export {};
