import { describe, expect, it } from "vitest";
import { createGhCommand } from "../src/gh/index.js";
import { parseArgs, flag, flagAll } from "../src/gh/args.js";
import { table, timeAgo, indent } from "../src/gh/format.js";

/** A fetch stand-in that records calls and replays scripted responses. */
function mockFetch(routes: Record<string, { status?: number; body: unknown; auth?: boolean }>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((r) => url.includes(r));
    const route = key ? routes[key]! : { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "x-ofx-authenticated": route.auth === false ? "false" : "true" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ctx = {
  cwd: "/workspace",
  exec: async (command: string) =>
    command.includes("remote get-url")
      ? { stdout: "https://github.com/octocat/Hello-World.git\n", exitCode: 0 }
      : { stdout: "switched\n", exitCode: 0 },
};

function run(gh: ReturnType<typeof createGhCommand>, line: string) {
  return (gh as unknown as {
    execute: (a: string[], c: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  }).execute(line.split(" ").filter(Boolean), ctx);
}

describe("argument parsing", () => {
  it("separates positionals, valued flags and repeats", () => {
    const args = parseArgs(["pr", "view", "12", "-R", "a/b", "-f", "x=1", "-f", "y=2"]);
    expect(args.positional).toEqual(["pr", "view", "12"]);
    expect(flag(args, "-R")).toBe("a/b");
    expect(flagAll(args, "-f")).toEqual(["x=1", "y=2"]);
  });

  it("accepts --name=value", () => {
    expect(flag(parseArgs(["--title=Some title"]), "--title")).toBe("Some title");
  });

  it("treats a trailing flag as a boolean", () => {
    expect(flag(parseArgs(["--draft"]), "--draft")).toBe("true");
  });
});

describe("formatting", () => {
  it("pads table columns but not the last", () => {
    expect(table([["#1", "short", "x"], ["#22", "much longer title", "y"]])).toBe(
      "#1   short              x\n#22  much longer title  y",
    );
  });

  it("renders ages the way gh does", () => {
    const twoDays = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    expect(timeAgo(twoDays)).toBe("about 2 days ago");
    expect(timeAgo(new Date().toISOString())).toBe("less than a minute ago");
  });

  it("indents bodies without indenting blank lines", () => {
    expect(indent("a\n\nb")).toBe("  a\n\n  b");
  });
});

describe("gh api", () => {
  it("passes the endpoint through and pretty-prints JSON", async () => {
    const { fn, calls } = mockFetch({ "repos/octocat": { body: { full_name: "octocat/Hello-World" } } });
    const gh = createGhCommand({ fetch: fn, apiBase: "/api/gh" });
    const result = await run(gh, "api repos/octocat/Hello-World");

    expect(result.exitCode).toBe(0);
    expect(calls[0]!.url).toBe("/api/gh/repos/octocat/Hello-World");
    expect(JSON.parse(result.stdout).full_name).toBe("octocat/Hello-World");
  });

  it("sends -f fields as a POST body, typing only -F values", async () => {
    const { fn, calls } = mockFetch({ "repos/x/y/issues": { body: { html_url: "u" } } });
    const gh = createGhCommand({ fetch: fn });
    await run(gh, "api repos/x/y/issues -f title=Hello -F draft=true");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ title: "Hello", draft: true });
  });

  it("surfaces GitHub's error message", async () => {
    const { fn } = mockFetch({ "repos/x": { status: 404, body: { message: "Not Found" } } });
    const gh = createGhCommand({ fetch: fn });
    const result = await run(gh, "api repos/x/y");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not Found");
  });
});

describe("repository resolution", () => {
  it("infers the repo from the origin remote", async () => {
    const { fn, calls } = mockFetch({ "pulls": { body: [] } });
    const gh = createGhCommand({ fetch: fn });
    await run(gh, "pr list");
    expect(calls[0]!.url).toContain("repos/octocat/Hello-World/pulls");
  });

  it("prefers an explicit --repo", async () => {
    const { fn, calls } = mockFetch({ "pulls": { body: [] } });
    const gh = createGhCommand({ fetch: fn });
    await run(gh, "pr list -R other/project");
    expect(calls[0]!.url).toContain("repos/other/project/pulls");
  });
});

describe("gh pr", () => {
  const pr = {
    number: 7,
    title: "Add a thing",
    state: "open",
    body: "Does the thing.",
    html_url: "https://github.com/octocat/Hello-World/pull/7",
    created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    user: { login: "octocat" },
    head: { ref: "feature" },
    base: { ref: "main" },
    commits: 2,
    additions: 10,
    deletions: 3,
    changed_files: 1,
  };

  it("lists in gh's table format", async () => {
    const { fn } = mockFetch({ "pulls?": { body: [pr] } });
    const gh = createGhCommand({ fetch: fn });
    const result = await run(gh, "pr list");

    expect(result.stdout).toContain("Showing 1 of 1 open pull requests in octocat/Hello-World");
    expect(result.stdout).toContain("#7");
    expect(result.stdout).toContain("feature");
    expect(result.stdout).toContain("about 2 days ago");
  });

  it("reports an empty list on stderr, as gh does", async () => {
    const { fn } = mockFetch({ "pulls?": { body: [] } });
    const gh = createGhCommand({ fetch: fn });
    const result = await run(gh, "pr list");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no open pull requests");
  });

  it("views a pull request with its merge summary", async () => {
    const { fn } = mockFetch({ "pulls/7": { body: pr } });
    const gh = createGhCommand({ fetch: fn });
    const result = await run(gh, "pr view 7");

    expect(result.stdout).toContain("Add a thing #7");
    expect(result.stdout).toContain("wants to merge 2 commits into main from feature");
    expect(result.stdout).toContain("+10 -3 • 1 changed file");
    expect(result.stdout).toContain("View this pull request on GitHub:");
  });

  it("creates a pull request and prints its url", async () => {
    const { fn, calls } = mockFetch({ "pulls": { body: { ...pr, html_url: "https://x/pull/9" } } });
    const gh = createGhCommand({ fetch: fn });
    const result = await run(gh, "pr create --title=New --head=feature --base=main");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ title: "New", head: "feature", base: "main" });
    expect(result.stdout.trim()).toBe("https://x/pull/9");
  });

  it("requires a title", async () => {
    const { fn } = mockFetch({});
    const result = await run(createGhCommand({ fetch: fn }), "pr create --head=x");
    expect(result.stderr).toContain("--title is required");
  });
});

describe("gh issue", () => {
  it("lists issues and excludes pull requests", async () => {
    const { fn } = mockFetch({
      "issues?": {
        body: [
          {
            number: 3,
            title: "A bug",
            state: "open",
            created_at: new Date().toISOString(),
            labels: [{ name: "bug" }],
          },
          { number: 4, title: "A PR", pull_request: {}, created_at: new Date().toISOString() },
        ],
      },
    });
    const result = await run(createGhCommand({ fetch: fn }), "issue list");
    expect(result.stdout).toContain("Showing 1 of 1 open issues");
    expect(result.stdout).toContain("#3");
    expect(result.stdout).not.toContain("#4");
  });
});

describe("gh auth status", () => {
  it("reports the signed-in account", async () => {
    const { fn } = mockFetch({ user: { body: { login: "haxzie" } } });
    const result = await run(createGhCommand({ fetch: fn }), "auth status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Logged in to github.com account haxzie");
    expect(result.stdout).toContain("never sent to the browser");
  });

  it("reports signed out when the proxy says anonymous", async () => {
    const { fn } = mockFetch({ user: { body: {}, auth: false } });
    const result = await run(createGhCommand({ fetch: fn }), "auth status");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not logged in");
  });
});

describe("help", () => {
  it("lists the implemented commands", async () => {
    const { fn } = mockFetch({});
    const result = await run(createGhCommand({ fetch: fn }), "");
    for (const command of ["api", "auth", "issue", "pr", "repo"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("rejects an unknown command", async () => {
    const { fn } = mockFetch({});
    const result = await run(createGhCommand({ fetch: fn }), "nonsense");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "nonsense"');
  });
});
