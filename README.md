# ofx

An open coding agent, written in Rust. One core, two hosts: a native CLI, and a
WebAssembly build that runs the same agent inside a browser tab.

- **1.99 MiB** native binary, **187 KiB** wasm (81 KiB gzip)
- Bring your own provider — **Anthropic**, **OpenAI**, **Gemini**, **Moonshot/Kimi**,
  **GLM/Zhipu**, or any OpenAI-compatible endpoint. Your key, your base URL, no gateway
  in between.
- Real tools: shell, read, write, edit, list, glob, grep — and `git`, because the agent
  gets an actual shell.

## Install

```sh
cargo install --path packages/ofx/crates/ofx-cli
```

## Use

```sh
export ANTHROPIC_API_KEY=sk-...

ofx "why is the build failing?"     # one shot
ofx                                 # interactive session
```

Inside a session: `/help`, `/clear`, `/model <id>`, `/provider <name>`, `/tokens`,
`/exit`. Ctrl-C cancels a running turn, Ctrl-D exits. History persists in `~/.ofx/history`.

Pick a provider with `--provider` (or `OFX_PROVIDER`); point it anywhere with
`--base-url`. Project instructions go in an `AGENTS.md` at the workspace root.

## Layout

```
packages/ofx/crates/
  ofx-core/   the agent: turn loop, provider adapters, SSE, tools, prompt. No I/O.
  ofx-cli/    native host — real shell, real files, reqwest.
  ofx-wasm/   browser host — a JS workspace bridge and fetch.

packages/git/  @wowsm/git — a virtual filesystem with git and bash, for the browser demo.
apps/web/      the demo: clone a repo into the tab, then put ofx to work on it.
```

`ofx-core` has no I/O of its own. A host supplies two traits — `Host` for the workspace
and `HttpClient` for the network — which is how the same code runs natively and in a
browser. Everything is `?Send`, because wasm futures are not.

## The browser demo

```sh
pnpm install
pnpm --filter @wowsm/web db:migrate:local   # once, creates the local D1 tables
pnpm --filter @wowsm/web dev:api            # the Worker: /api/auth and /api/git
pnpm dev                                    # the app, proxying /api to it
```

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-pack`. Two processes: Vite
serves the app with HMR and proxies `/api` to `wrangler dev`, so the browser stays on one
origin and session cookies behave.

The workspace is a virtual filesystem in the tab, persisted to IndexedDB: clone a real
repository into it, then run `ofx` against it. Git is
[just-git](https://github.com/blindmansion/just-git) and the shell is
[just-bash](https://github.com/vercel-labs/just-bash), both pure TypeScript.

Browsers cannot reach GitHub's git endpoints directly, so the Worker proxies them at
`/api/git`. Signing in is optional — public repositories clone anonymously. Sign-in adds
private repositories and push, and the GitHub token never reaches the browser: Better Auth
stores it encrypted in D1, and the page holds only a short-lived JWT that the proxy
exchanges for the real credential server-side.

### Auth setup

A GitHub OAuth App allows exactly one callback URL, so local and production need separate
apps. Register them at https://github.com/settings/developers with callback URLs:

| | Callback URL |
|---|---|
| Local | `http://localhost:5173/api/auth/callback/github` |
| Production | `https://<your-worker>.workers.dev/api/auth/callback/github` |

Locally, copy `apps/web/.dev.vars.example` to `.dev.vars` and fill in the credentials. In
production they are Worker secrets:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put BETTER_AUTH_SECRET
```

## Development

```sh
cargo test --workspace     # in packages/ofx
pnpm -r test               # TypeScript
pnpm -r typecheck
```

## Prior art

Inspired by [fx](https://github.com/vercel-labs/fx), which is a far larger and more
capable agent. ofx exists to be small, and to let you point it at whichever model you
already pay for.

## License

Apache-2.0
