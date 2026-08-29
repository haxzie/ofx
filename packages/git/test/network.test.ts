import { describe, expect, it } from "vitest";
import type { CustomCommand } from "just-bash/browser";
import { PersistentFs } from "../src/fs/persistent-fs.js";
import { createGitEngine } from "../src/engine.js";
import { createWorkspace } from "../src/workspace.js";
import { createShell } from "../src/shell.js";
import { getStatus } from "../src/status.js";

/**
 * Hits the real network (GitHub via a public CORS proxy), so it is opt-in:
 *
 *   WOWSM_NETWORK=1 pnpm --filter @wowsm/git test
 *
 * This is the check that the browser's clone path actually works — the proxy
 * URL scheme, the sideband progress, and the engine wiring end to end.
 */
const ENABLED = process.env.WOWSM_NETWORK === "1";
const PROXY = process.env.WOWSM_CORS_PROXY ?? "https://cors.isomorphic-git.org";
const REPO = "https://github.com/octocat/Hello-World";
const WORKSPACE = "/workspace";

describe.skipIf(!ENABLED)("clone through the CORS proxy", () => {
  it("clones a public repo, then commits a local edit", { timeout: 120_000 }, async () => {
    const progress: string[] = [];
    const fs = new PersistentFs({ persist: false });
    await fs.mkdir(WORKSPACE, { recursive: true });

    const git = createGitEngine({
      fs,
      cwd: WORKSPACE,
      identity: { name: "Spike", email: "spike@wowsm.local" },
      corsProxy: () => PROXY,
      onProgress: (m) => progress.push(m),
    });
    const shell = createShell({ fs, cwd: WORKSPACE, customCommands: [git as unknown as CustomCommand] });

    const clone = await shell.run(`git clone ${REPO} ${WORKSPACE}/hello`);
    expect(clone.exitCode, clone.stderr).toBe(0);
    expect(progress.join("")).toContain("Enumerating objects");

    await shell.run("cd hello");
    expect(await fs.exists(`${WORKSPACE}/hello/.git`)).toBe(true);

    const log = await shell.run("git log --oneline");
    expect(log.stdout.trim().split("\n").length).toBeGreaterThan(1);

    await shell.run("echo 'a line from the browser' >> README");
    const status = await getStatus(git, { fs, cwd: `${WORKSPACE}/hello` });
    expect(status).toEqual([expect.objectContaining({ path: "README", state: "modified", added: 1 })]);

    const commit = await shell.run("git add . && git commit -m 'edit from wowsm'");
    expect(commit.exitCode, commit.stderr).toBe(0);

    const after = await shell.run("git log --oneline");
    expect(after.stdout).toContain("edit from wowsm");
  });
});

describe.skipIf(!ENABLED)("repositories with relative symlinks", () => {
  it(
    "checks out a repo whose symlink targets contain ..",
    { timeout: 300_000 },
    async () => {
      // supabase-js carries .claude/skills/* -> ../../.agents/skills/*, which
      // just-git refuses to create as symlinks even though they resolve inside
      // the repo. Driven through createWorkspace, which is how the app runs
      // git, those become regular files instead — as git does with
      // core.symlinks=false.
      const ws = await createWorkspace({
        fs: { persist: false },
        identity: { name: "Spike", email: "spike@ofx.local" },
        corsProxy: () => PROXY,
      });

      const result = await ws.shell.run(
        `git clone --depth 1 https://github.com/supabase/supabase-js.git ${ws.root}/sb`,
      );
      expect(result.stderr).not.toContain("unsafe target");
      expect(result.exitCode, result.stderr).toBe(0);

      // The link is present as a file holding its target path.
      const link = `${ws.root}/sb/.claude/skills/link-workspace-packages`;
      expect(await ws.fs.exists(link)).toBe(true);
      expect(await ws.fs.readFile(link)).toContain("../../.agents/skills/");
    },
  );
});
