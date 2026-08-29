import { beforeEach, describe, expect, it } from "vitest";
import type { CustomCommand } from "just-bash/browser";
import { PersistentFs } from "../src/fs/persistent-fs.js";
import { createGitEngine } from "../src/engine.js";
import { createShell, type Shell } from "../src/shell.js";
import { createWorkspace } from "../src/workspace.js";
import { getStatus } from "../src/status.js";
import type { Git } from "just-git";

const WORKSPACE = "/workspace";

interface Harness {
  fs: PersistentFs;
  git: Git;
  shell: Shell;
}

async function harness(): Promise<Harness> {
  const fs = new PersistentFs({ persist: false });
  await fs.mkdir(WORKSPACE, { recursive: true });

  const git = createGitEngine({
    fs,
    cwd: WORKSPACE,
    identity: { name: "Test User", email: "test@example.com" },
    corsProxy: null,
  });

  const shell = createShell({
    fs,
    cwd: WORKSPACE,
    // just-git's Git is structurally a just-bash Command; the two packages
    // declare their own CommandContext, hence the cast.
    customCommands: [git as unknown as CustomCommand],
  });

  return { fs, git, shell };
}

describe("shell session state", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("carries cwd across separate exec calls", async () => {
    // Bash.exec discards cwd between calls; the Shell state machine is what
    // makes this work.
    await h.shell.run("mkdir -p sub/deeper");
    await h.shell.run("cd sub/deeper");
    const pwd = await h.shell.run("pwd");

    expect(pwd.stdout.trim()).toBe(`${WORKSPACE}/sub/deeper`);
    expect(h.shell.cwd).toBe(`${WORKSPACE}/sub/deeper`);
  });

  it("carries exported variables across calls", async () => {
    await h.shell.run("export GREETING=hello");
    const result = await h.shell.run("echo $GREETING");
    expect(result.stdout.trim()).toBe("hello");
  });

  it("records history and exposes it to the history builtin", async () => {
    await h.shell.run("echo one");
    await h.shell.run("echo two");
    const result = await h.shell.run("history");

    expect(h.shell.history).toEqual(["echo one", "echo two", "history"]);
    expect(result.stdout).toContain("echo one");
    expect(result.stdout).toContain("echo two");
  });

  it("propagates non-zero exit codes", async () => {
    const result = await h.shell.run("cat /does/not/exist");
    expect(result.exitCode).not.toBe(0);
  });
});

describe("git over the virtual filesystem", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("runs init -> write -> add -> commit -> log", async () => {
    expect((await h.shell.run("git init")).exitCode).toBe(0);
    expect(await h.fs.exists(`${WORKSPACE}/.git`)).toBe(true);

    await h.shell.run("echo 'hello world' > README.md");
    expect((await h.shell.run("git add .")).exitCode).toBe(0);

    const commit = await h.shell.run("git commit -m 'initial commit'");
    expect(commit.exitCode).toBe(0);

    const log = await h.shell.run("git log --oneline");
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("initial commit");
  });

  it("shows the diff of an uncommitted edit", async () => {
    await h.shell.run("git init");
    await h.shell.run("printf 'one\\ntwo\\nthree\\n' > file.txt");
    await h.shell.run("git add .");
    await h.shell.run("git commit -m base");

    await h.shell.run("printf 'one\\nTWO\\nthree\\nfour\\n' > file.txt");
    const diff = await h.shell.run("git diff");

    expect(diff.stdout).toContain("-two");
    expect(diff.stdout).toContain("+TWO");
    expect(diff.stdout).toContain("+four");
  });

  it("composes with shell pipes and redirection", async () => {
    await h.shell.run("git init");
    await h.shell.run("echo a > a.txt && echo b > b.txt");
    await h.shell.run("git add . && git commit -m two-files");

    const result = await h.shell.run("git log --oneline | wc -l");
    expect(result.stdout.trim()).toBe("1");
  });
});

describe("status decorations", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await h.shell.run("git init");
    await h.shell.run("printf 'one\\ntwo\\nthree\\n' > tracked.txt");
    await h.shell.run("git add . && git commit -m base");
  });

  it("reports line deltas for a modified file", async () => {
    await h.shell.run("printf 'one\\nCHANGED\\nthree\\nfour\\n' > tracked.txt");

    const status = await getStatus(h.git, { fs: h.fs, cwd: WORKSPACE });
    const entry = status.find((s) => s.path === "tracked.txt");

    expect(entry).toBeDefined();
    expect(entry?.state).toBe("modified");
    expect(entry?.added).toBe(2);
    expect(entry?.removed).toBe(1);
    expect(entry?.unstaged).toBe(true);
  });

  it("counts an untracked file as all-added", async () => {
    await h.shell.run("printf 'x\\ny\\n' > brand-new.txt");

    const status = await getStatus(h.git, { fs: h.fs, cwd: WORKSPACE });
    const entry = status.find((s) => s.path === "brand-new.txt");

    expect(entry?.state).toBe("untracked");
    expect(entry?.added).toBe(2);
    expect(entry?.removed).toBe(0);
  });

  it("sums staged and unstaged deltas for the same file", async () => {
    await h.shell.run("printf 'one\\ntwo\\nthree\\nSTAGED\\n' > tracked.txt");
    await h.shell.run("git add tracked.txt");
    await h.shell.run("printf 'one\\ntwo\\nthree\\nSTAGED\\nUNSTAGED\\n' > tracked.txt");

    const status = await getStatus(h.git, { fs: h.fs, cwd: WORKSPACE });
    const entry = status.find((s) => s.path === "tracked.txt");

    expect(entry?.added).toBe(2);
    expect(entry?.staged).toBe(true);
    expect(entry?.unstaged).toBe(true);
  });

  it("returns nothing when the tree is clean", async () => {
    const status = await getStatus(h.git, { fs: h.fs, cwd: WORKSPACE });
    expect(status).toEqual([]);
  });

  it("marks a deleted file", async () => {
    await h.shell.run("rm tracked.txt");

    const status = await getStatus(h.git, { fs: h.fs, cwd: WORKSPACE });
    const entry = status.find((s) => s.path === "tracked.txt");
    expect(entry?.state).toBe("deleted");
  });
});

describe("workspace wiring", () => {
  it("gives gh the same session credential as git", async () => {
    // The bug this guards: gh sent only the session cookie, while the proxy
    // identifies callers by the Bearer JWT — so gh was anonymous even when
    // signed in.
    const seen: (string | null)[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ login: "haxzie" }), {
        status: 200,
        headers: { "x-ofx-authenticated": "true" },
      });
    }) as unknown as typeof fetch;

    const ws = await createWorkspace({
      fs: { persist: false },
      token: () => "jwt-from-session",
      corsProxy: null,
      gh: { fetch: fakeFetch },
    });

    const result = await ws.shell.run("gh auth status");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(seen[0]).toBe("Bearer jwt-from-session");
  });
});
