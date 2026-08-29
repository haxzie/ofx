import { describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/workspace.js";
import type { PyodideRuntime } from "../src/python.js";

/** Stands in for Pyodide: runs a couple of trivial programs, records loads. */
function fakeRuntime() {
  let loads = 0;
  let stdout: ((t: string) => void) | null = null;
  let stderr: ((t: string) => void) | null = null;

  const runtime: PyodideRuntime = {
    setStdout: ({ batched }) => void (stdout = batched),
    setStderr: ({ batched }) => void (stderr = batched),
    runPythonAsync: async (code: string) => {
      if (code.includes("boom")) throw new Error('Traceback:\n  RuntimeError: boom');
      if (code.includes("warn")) stderr?.("a warning");
      const printed = code.match(/print\((.*)\)/)?.[1] ?? "";
      stdout?.(printed.replace(/^['"]|['"]$/g, ""));
      return undefined;
    },
  };

  return {
    loadRuntime: async () => {
      loads += 1;
      return runtime;
    },
    loadCount: () => loads,
  };
}

async function shellWith(fake: ReturnType<typeof fakeRuntime>, onProgress?: (m: string) => void) {
  const ws = await createWorkspace({
    fs: { persist: false },
    corsProxy: null,
    python: { loadRuntime: fake.loadRuntime, onProgress },
  });
  return ws.shell;
}

describe("python -c", () => {
  it("runs code and returns its output", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run(`python -c 'print("hello")'`);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("reports a Python exception on stderr with a non-zero exit", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run(`python -c 'boom'`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RuntimeError: boom");
  });

  it("keeps stderr separate from stdout", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run(`python -c 'warn print("ok")'`);
    expect(result.stderr).toContain("a warning");
  });
});

describe("python from stdin", () => {
  it("runs a piped program", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run(`echo 'print("piped")' | python`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("piped");
  });

  it("prints usage when given neither -c nor stdin", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run("python");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no filesystem access");
  });
});

describe("the filesystem boundary", () => {
  it("refuses a script file, explaining why", async () => {
    const shell = await shellWith(fakeRuntime());
    const result = await shell.run("python script.py");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no access to the workspace filesystem");
    // The message must point somewhere useful rather than just failing.
    expect(result.stderr).toContain("-c");
  });
});

describe("lazy loading", () => {
  it("downloads nothing until python is first run", async () => {
    const fake = fakeRuntime();
    const shell = await shellWith(fake);

    await shell.run("echo unrelated");
    expect(fake.loadCount()).toBe(0);

    await shell.run(`python -c 'print(1)'`);
    expect(fake.loadCount()).toBe(1);
  });

  it("loads once and reuses the interpreter", async () => {
    const fake = fakeRuntime();
    const shell = await shellWith(fake);

    await shell.run(`python -c 'print(1)'`);
    await shell.run(`python -c 'print(2)'`);
    expect(fake.loadCount()).toBe(1);
  });

  it("announces the download before it starts", async () => {
    const fake = fakeRuntime();
    const onProgress = vi.fn();
    const shell = await shellWith(fake, onProgress);

    await shell.run(`python -c 'print(1)'`);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0]![0]).toContain("11 MiB");
  });
});

describe("version and help", () => {
  it("reports a version without loading the runtime", async () => {
    const fake = fakeRuntime();
    const shell = await shellWith(fake);
    const result = await shell.run("python --version");

    expect(result.stdout).toContain("Pyodide");
    expect(fake.loadCount()).toBe(0);
  });
});

describe("opting out", () => {
  it("leaves python unregistered when disabled", async () => {
    const ws = await createWorkspace({ fs: { persist: false }, corsProxy: null, python: false });
    const result = await ws.shell.run(`python -c 'print(1)'`);
    expect(result.exitCode).not.toBe(0);
  });
});
