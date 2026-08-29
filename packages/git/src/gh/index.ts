import type { CustomCommand } from "just-bash/browser";
import { flag, flagAll, hasFlag, parseArgs, type ParsedArgs } from "./args.js";
import { indent, pluralize, table, timeAgo } from "./format.js";

export interface GhOptions {
  /**
   * Base path of the GitHub API proxy. The proxy attaches the signed-in user's
   * token server-side, so no credential is held in the page.
   */
  apiBase?: string;
  /**
   * Resolves the session JWT the proxy exchanges for a GitHub token. Without
   * it every request is anonymous, which is the right behaviour signed out.
   */
  token?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
}

interface Ctx {
  cwd: string;
  exec?: (
    command: string,
    options: { cwd: string },
  ) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
}

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ok = (stdout: string): Result => ({ stdout: stdout.endsWith("\n") || stdout === "" ? stdout : `${stdout}\n`, stderr: "", exitCode: 0 });
const fail = (message: string, code = 1): Result => ({ stdout: "", stderr: `${message}\n`, exitCode: code });

const HELP = `Work with GitHub from the browser.

USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS
  api          make an authenticated GitHub API request
  auth         show authentication status
  issue        manage issues
  pr           manage pull requests
  repo         view repositories

FLAGS
  -R, --repo OWNER/REPO   act on this repository instead of the checkout's origin
`;

export function createGhCommand(options: GhOptions = {}): CustomCommand {
  const apiBase = (options.apiBase ?? "/api/gh").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const resolveToken = options.token ?? (() => null);

  interface ApiResponse<T> {
    status: number;
    data: T;
    authenticated: boolean;
  }

  async function api<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const clean = path.replace(/^\//, "");
    // The proxy identifies the caller by this JWT, exactly as the git
    // transport does; the cookie alone is not enough.
    const jwt = await resolveToken();
    const response = await doFetch(`${apiBase}/${clean}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "include",
    });

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Some endpoints answer with raw text; keep it as-is.
    }
    return {
      status: response.status,
      data: data as T,
      authenticated: response.headers.get("x-ofx-authenticated") === "true",
    };
  }

  /** gh reports API failures with the message GitHub returned. */
  function apiError(response: ApiResponse<unknown>): string {
    const body = response.data as { message?: string } | null;
    const message = body?.message ?? `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      return `${message} (sign in to act as your account)`;
    }
    return message;
  }

  /** Resolve OWNER/REPO from -R, or from the checkout's origin remote. */
  async function resolveRepo(args: ParsedArgs, ctx: Ctx): Promise<string> {
    const explicit = flag(args, "-R", "--repo");
    if (explicit) return explicit.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

    if (!ctx.exec) throw new Error("no repository given; pass --repo OWNER/REPO");
    const remote = await ctx.exec("git remote get-url origin", { cwd: ctx.cwd });
    const url = remote.stdout.trim();
    if (remote.exitCode !== 0 || !url) {
      throw new Error(
        "no git remote found; run this inside a clone or pass --repo OWNER/REPO",
      );
    }
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match?.[1]) throw new Error(`could not parse a GitHub repository from ${url}`);
    return match[1];
  }

  // ---------------------------------------------------------------- gh api

  async function ghApi(args: ParsedArgs): Promise<Result> {
    const endpoint = args.positional[0];
    if (!endpoint) return fail("gh api: an endpoint is required");

    const fields = [...flagAll(args, "-f", "--field", "-F", "--raw-field")];
    const method = flag(args, "-X", "--method") ?? (fields.length ? "POST" : "GET");

    let body: Record<string, unknown> | undefined;
    if (fields.length) {
      body = {};
      for (const entry of fields) {
        const split = entry.indexOf("=");
        if (split === -1) continue;
        const key = entry.slice(0, split);
        const raw = entry.slice(split + 1);
        // -F takes a typed value; -f is always a string.
        body[key] = /^(true|false|null|-?\d+(\.\d+)?)$/.test(raw) ? JSON.parse(raw) : raw;
      }
    }

    const headers: Record<string, string> = {};
    for (const header of flagAll(args, "-H", "--header")) {
      const split = header.indexOf(":");
      if (split > 0) headers[header.slice(0, split).trim()] = header.slice(split + 1).trim();
    }

    const response = await api<unknown>(endpoint, { method, body, headers });
    if (response.status >= 400) return fail(`gh: ${apiError(response)}`, 1);
    return ok(typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2));
  }

  // --------------------------------------------------------------- gh auth

  async function ghAuth(args: ParsedArgs): Promise<Result> {
    if (args.positional[0] && args.positional[0] !== "status") {
      return fail(`gh auth: unknown subcommand "${args.positional[0]}"`);
    }
    const response = await api<{ login?: string; message?: string }>("user");
    if (!response.authenticated || response.status >= 400) {
      return {
        stdout: "",
        stderr:
          "github.com\n  X Not logged in to github.com\n\n  Sign in from the settings panel to act as your account.\n",
        exitCode: 1,
      };
    }
    const scopes = "repo";
    return ok(
      [
        "github.com",
        `  ✓ Logged in to github.com account ${response.data.login ?? "unknown"} (ofx session)`,
        "  - Active account: true",
        "  - Git operations protocol: https",
        "  - Token: kept server-side, never sent to the browser",
        `  - Token scopes: '${scopes}'`,
      ].join("\n"),
    );
  }

  // ----------------------------------------------------------------- gh pr

  interface PullRequest {
    number: number;
    title: string;
    state: string;
    draft?: boolean;
    body?: string | null;
    html_url: string;
    created_at: string;
    user?: { login?: string };
    head?: { ref?: string };
    base?: { ref?: string };
    commits?: number;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    merged?: boolean;
  }

  function prState(pr: PullRequest): string {
    if (pr.merged) return "Merged";
    if (pr.state === "closed") return "Closed";
    return pr.draft ? "Draft" : "Open";
  }

  async function ghPr(args: ParsedArgs, ctx: Ctx): Promise<Result> {
    const sub = args.positional[0] ?? "list";
    const repo = await resolveRepo(args, ctx);

    if (sub === "list") {
      const state = flag(args, "--state", "-s") ?? "open";
      const limit = Number(flag(args, "--limit", "-L") ?? 30);
      const response = await api<PullRequest[]>(
        `repos/${repo}/pulls?state=${state}&per_page=${limit}`,
      );
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      const prs = response.data;
      if (prs.length === 0) {
        return { stdout: "", stderr: `no open pull requests in ${repo}\n`, exitCode: 1 };
      }
      const rows = prs.map((pr) => [
        `#${pr.number}`,
        pr.title,
        pr.head?.ref ?? "",
        timeAgo(pr.created_at),
      ]);
      return ok(
        `\nShowing ${prs.length} of ${prs.length} ${state} pull requests in ${repo}\n\n${table(rows)}\n`,
      );
    }

    if (sub === "view") {
      const number = args.positional[1];
      if (!number) return fail("gh pr view: a pull request number is required");
      const response = await api<PullRequest>(`repos/${repo}/pulls/${number}`);
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      const pr = response.data;
      const lines = [
        `${pr.title} #${pr.number}`,
        `${prState(pr)} • ${pr.user?.login ?? "unknown"} wants to merge ${pluralize(pr.commits ?? 0, "commit")} into ${pr.base?.ref ?? "?"} from ${pr.head?.ref ?? "?"}`,
        `+${pr.additions ?? 0} -${pr.deletions ?? 0} • ${pluralize(pr.changed_files ?? 0, "changed file")}`,
        "",
        pr.body ? indent(pr.body.trim()) : indent("No description provided"),
        "",
        `View this pull request on GitHub: ${pr.html_url}`,
      ];
      return ok(lines.join("\n"));
    }

    if (sub === "create") {
      if (!ctx.exec) return fail("gh pr create: no shell available");

      // gh takes the head from the current branch unless told otherwise.
      let head = flag(args, "--head", "-H");
      if (!head) {
        const branch = await ctx.exec("git rev-parse --abbrev-ref HEAD", { cwd: ctx.cwd });
        head = branch.stdout.trim();
        if (branch.exitCode !== 0 || !head || head === "HEAD") {
          return fail("gh pr create: could not determine the current branch; pass --head");
        }
      }

      // ...and the base from the repository's default branch.
      let base = flag(args, "--base", "-B");
      if (!base) {
        const info = await api<{ default_branch?: string }>(`repos/${repo}`);
        if (info.status >= 400) return fail(`gh: ${apiError(info)}`);
        base = info.data.default_branch ?? "main";
      }

      if (head === base) {
        return fail(
          `gh pr create: the current branch (${head}) is the base branch; create a branch first`,
        );
      }

      let title = flag(args, "--title", "-t");
      let body = flag(args, "--body", "-b") ?? "";

      // --fill takes the title and body from the latest commit, as gh does.
      if (hasFlag(args, "--fill") && !title) {
        const subject = await ctx.exec("git log -1 --format=%s", { cwd: ctx.cwd });
        const message = await ctx.exec("git log -1 --format=%b", { cwd: ctx.cwd });
        title = subject.stdout.trim();
        if (!body) body = message.stdout.trim();
      }
      if (!title) return fail("gh pr create: --title is required (or pass --fill)");

      // The branch must exist on the remote before a pull request can
      // reference it. gh offers to push; here it just happens.
      const notices: string[] = [];
      const onRemote = await ctx.exec(`git rev-parse --verify --quiet origin/${head}`, {
        cwd: ctx.cwd,
      });
      if (onRemote.exitCode !== 0 || !onRemote.stdout.trim()) {
        const pushed = await ctx.exec(`git push -u origin ${head}`, { cwd: ctx.cwd });
        if (pushed.exitCode !== 0) {
          return fail(
            `gh pr create: could not push ${head} to origin\n${pushed.stderr ?? pushed.stdout}`.trim(),
          );
        }
        notices.push(`Pushed ${head} to origin`);
      }

      const response = await api<PullRequest>(`repos/${repo}/pulls`, {
        method: "POST",
        body: { title, body, head, base, draft: hasFlag(args, "--draft", "-d") },
      });
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);

      return {
        stdout: `${response.data.html_url}\n`,
        stderr: notices.length ? `${notices.join("\n")}\n` : "",
        exitCode: 0,
      };
    }

    if (sub === "checkout") {
      const number = args.positional[1];
      if (!number) return fail("gh pr checkout: a pull request number is required");
      if (!ctx.exec) return fail("gh pr checkout: no shell available");
      const response = await api<PullRequest>(`repos/${repo}/pulls/${number}`);
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      const branch = response.data.head?.ref ?? `pr-${number}`;
      const fetched = await ctx.exec(
        `git fetch origin pull/${number}/head:${branch} && git checkout ${branch}`,
        { cwd: ctx.cwd },
      );
      if (fetched.exitCode !== 0) return fail(fetched.stdout || "checkout failed");
      return ok(fetched.stdout);
    }

    return fail(`gh pr: unknown subcommand "${sub}"`);
  }

  // -------------------------------------------------------------- gh issue

  interface Issue {
    number: number;
    title: string;
    state: string;
    body?: string | null;
    html_url: string;
    created_at: string;
    user?: { login?: string };
    labels?: { name?: string }[];
    comments?: number;
    pull_request?: unknown;
  }

  async function ghIssue(args: ParsedArgs, ctx: Ctx): Promise<Result> {
    const sub = args.positional[0] ?? "list";
    const repo = await resolveRepo(args, ctx);

    if (sub === "list") {
      const state = flag(args, "--state", "-s") ?? "open";
      const limit = Number(flag(args, "--limit", "-L") ?? 30);
      const response = await api<Issue[]>(`repos/${repo}/issues?state=${state}&per_page=${limit}`);
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      // The issues endpoint also returns pull requests; gh lists only issues.
      const issues = response.data.filter((i) => !i.pull_request);
      if (issues.length === 0) {
        return { stdout: "", stderr: `no open issues in ${repo}\n`, exitCode: 1 };
      }
      const rows = issues.map((issue) => [
        `#${issue.number}`,
        issue.title,
        (issue.labels ?? []).map((l) => l.name).filter(Boolean).join(", "),
        timeAgo(issue.created_at),
      ]);
      return ok(
        `\nShowing ${issues.length} of ${issues.length} ${state} issues in ${repo}\n\n${table(rows)}\n`,
      );
    }

    if (sub === "view") {
      const number = args.positional[1];
      if (!number) return fail("gh issue view: an issue number is required");
      const response = await api<Issue>(`repos/${repo}/issues/${number}`);
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      const issue = response.data;
      const labels = (issue.labels ?? []).map((l) => l.name).filter(Boolean).join(", ");
      return ok(
        [
          `${issue.title} #${issue.number}`,
          `${issue.state === "open" ? "Open" : "Closed"} • ${issue.user?.login ?? "unknown"} opened ${timeAgo(issue.created_at)} • ${pluralize(issue.comments ?? 0, "comment")}`,
          labels ? `Labels: ${labels}` : "",
          "",
          issue.body ? indent(issue.body.trim()) : indent("No description provided"),
          "",
          `View this issue on GitHub: ${issue.html_url}`,
        ]
          .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
          .join("\n"),
      );
    }

    if (sub === "create") {
      const title = flag(args, "--title", "-t");
      if (!title) return fail("gh issue create: --title is required");
      const response = await api<Issue>(`repos/${repo}/issues`, {
        method: "POST",
        body: { title, body: flag(args, "--body", "-b") ?? "" },
      });
      if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
      return ok(response.data.html_url);
    }

    return fail(`gh issue: unknown subcommand "${sub}"`);
  }

  // --------------------------------------------------------------- gh repo

  interface Repo {
    full_name: string;
    description?: string | null;
    stargazers_count?: number;
    forks_count?: number;
    language?: string | null;
    default_branch?: string;
    html_url: string;
    private?: boolean;
  }

  async function ghRepo(args: ParsedArgs, ctx: Ctx): Promise<Result> {
    const sub = args.positional[0] ?? "view";
    if (sub !== "view") return fail(`gh repo: unknown subcommand "${sub}"`);

    const named = args.positional[1];
    const repo = named
      ? named.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")
      : await resolveRepo(args, ctx);

    const response = await api<Repo>(`repos/${repo}`);
    if (response.status >= 400) return fail(`gh: ${apiError(response)}`);
    const data = response.data;

    const readme = await api<{ content?: string }>(`repos/${repo}/readme`);
    let body = "";
    if (readme.status < 400 && readme.data.content) {
      try {
        body = decodeURIComponent(escape(atob(readme.data.content.replace(/\n/g, ""))));
      } catch {
        body = "";
      }
    }

    return ok(
      [
        data.full_name + (data.private ? " (private)" : ""),
        data.description ?? "No description provided",
        `${data.stargazers_count ?? 0} stars • ${data.forks_count ?? 0} forks${data.language ? ` • ${data.language}` : ""}`,
        "",
        body ? indent(body.trim()) : indent("This repository has no README"),
        "",
        `View this repository on GitHub: ${data.html_url}`,
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------- dispatch

  return {
    name: "gh",
    async execute(argv: string[], ctx: unknown): Promise<Result> {
      const context = ctx as Ctx;
      const args = parseArgs(argv);
      const command = args.positional.shift();

      if (!command || command === "help" || hasFlag(args, "--help", "-h")) return ok(HELP);

      try {
        switch (command) {
          case "api":
            return await ghApi(args);
          case "auth":
            return await ghAuth(args);
          case "pr":
            return await ghPr(args, context);
          case "issue":
            return await ghIssue(args, context);
          case "repo":
            return await ghRepo(args, context);
          default:
            return fail(`gh: unknown command "${command}"\n\n${HELP}`);
        }
      } catch (error) {
        return fail(`gh: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  } as unknown as CustomCommand;
}
