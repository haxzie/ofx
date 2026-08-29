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

## Architecture

### Design

The whole point is a single core with no I/O of its own, driven by two thin
hosts. `ofx-core` owns the turn loop, the provider adapters, the tool
definitions and the system prompt; it depends only on two traits it declares
itself — `Host` for the workspace and `HttpClient` for the network. Everything
in the core is `?Send`, because wasm futures cannot be `Send` and requiring it
would rule out the browser target. A host — `ofx-cli` or `ofx-wasm` —
implements those two traits with whatever is natural for its environment and
otherwise never touches the agent's internals.

```
                          +----------------------------+
                          |           ofx-core          |
                          |  agent . provider . tool .  |
                          |  message . sse . prompt     |
                          |      (no I/O, ?Send)        |
                          +-----+----------------+------+
                    Host trait  |                |  HttpClient trait
                    +-----------+                +-----------+
                    v                                        v
          +------------------------+          +------------------------+
          |         ofx-cli        |          |        ofx-wasm        |
          | NativeHost: real fs +  |          | JsHost: bridges to a   |
          | `$SHELL -c`            |          | JS workspace           |
          | ReqwestClient          |          | FetchClient: wraps     |
          |                        |          | browser `fetch`        |
          +------------------------+          +------------------------+
```

### `ofx-core` (`packages/ofx/crates/ofx-core`)

- **`agent.rs`** — `Agent::run_turn` is the loop: push the user message, ask
  the provider to build an HTTP request from the conversation, stream the
  response, execute any tool calls the model asked for, append their results,
  and repeat until the model stops or `max_steps` is hit. A `Turn` accumulates
  streamed `Delta`s (text, tool-call fragments keyed by index, stop reason,
  usage) into one assistant message per round.
- **`provider/`** — one adapter per wire format, each implementing
  `build_request` (normalized `RequestContext` → `HttpRequest`) and `on_event`
  (one `SseEvent` → zero or more `Delta`s). `anthropic.rs` speaks the Messages
  API; `openai.rs` speaks Chat Completions and also serves Moonshot/Kimi and
  GLM/Zhipu, which differ only by base URL, model id and the older
  `max_tokens` field; `gemini.rs` speaks Google's generateContent streaming
  format. `ProviderId` carries each provider's default base URL, default
  model and API-key env var, and `.build()` returns the boxed adapter.
- **`tool.rs`** — the seven built-in tools (`bash`, `read_file`, `write_file`,
  `edit_file`, `list_files`, `glob_files`, `grep_files`), their JSON schemas
  for the model, and `dispatch`, which runs one call against a `&dyn Host` and
  renders its result as text, truncating at 64 KiB on a UTF-8 boundary.
  `edit_file` requires its `old_string` to match exactly once, so a blind edit
  either lands unambiguously or fails loudly.
- **`sse.rs`** — a chunk-agnostic server-sent-events parser shared by every
  provider.
- **`message.rs` / `event.rs` / `prompt.rs`** — the normalized conversation
  types (`Message`, `Content`, `StopReason`), the `AgentEvent`s a host
  observes as a turn runs (`TextDelta`, `ToolStart`/`ToolEnd`, `StepComplete`,
  `TurnComplete`), and the system prompt template. The prompt is deliberately
  short and takes an optional one-line description of what the host's shell
  actually provides beyond git — `AgentConfig.workspace_tools` — so a host that
  offers more than `bash` alone can say so and have the model use it.
- **`host.rs` / `http.rs`** — the two traits a host must implement: `Host`
  (`exec`, `read_file`, `write_file`, `list_dir`, `glob`, `cwd`) and
  `HttpClient` (one `send`, returning a status and a `ByteStream`). `git`
  needs no special modelling — it is just another `bash` command, so both
  hosts get it for free as long as `exec` can reach a `git` binary.

### `ofx-cli` (`packages/ofx/crates/ofx-cli`)

The native binary. `NativeHost` runs commands with `tokio::process::Command`
under `$SHELL -c`, and reads/writes/globs the real filesystem rooted at the
working directory. `ReqwestClient` streams responses via `reqwest`. Before a
session starts, `main.rs` probes `PATH` for `gh`, `rg`, `jq` and `curl` and
folds whichever are present into `workspace_tools`, so the model learns about
them instead of assuming only git is available. `repl.rs` drives an
interactive session (`rustyline` for input, in-process slash commands like
`/model` and `/provider`) or a single one-shot turn; `render.rs` and
`spinner.rs` turn `AgentEvent`s into terminal output, including a rotating-
phrase spinner while a turn is in flight. Everything runs on a current-thread
Tokio runtime, matching the core's `?Send` futures.

### `ofx-wasm` (`packages/ofx/crates/ofx-wasm`)

The browser binding, compiled with `wasm-pack`. `lib.rs` exposes a
`#[wasm_bindgen]` `OfxAgent` class: constructed with a JSON config, a
`JsWorkspace` (an object supplying `exec`/`readFile`/`writeFile`/`listDir`/
`glob`/`cwd`) and an optional `fetch` override, it wraps them in `JsHost` and
`FetchClient` and rebuilds a fresh `Agent` for each `runTurn` call, restoring
the conversation from `messages` kept on the JS side of the boundary. Events
are forwarded to a JS callback via `serde-wasm-bindgen`'s JSON-compatible
serializer (the default one turns a map into a JS `Map`, which the demo's UI
can't read); a request can be cancelled with an `AbortSignal`.
`browser_direct` is set unconditionally because requests originate from a
page.

### `packages/git` (`@wowsm/git`)

A virtual filesystem plus a shell environment for the browser demo, built on
[just-git](https://github.com/blindmansion/just-git) and
[just-bash](https://github.com/vercel-labs/just-bash) — both pure TypeScript,
so they run in a tab with no server. `createWorkspace` (`workspace.ts`) wires
it together: `fs/persistent-fs.ts` backs the filesystem with IndexedDB so a
cloned repository survives a reload; `engine.ts` registers git as a just-bash
command; and, each optional and independently toggleable, `gh/` registers a
`gh` command that talks to the Worker's `/api/gh` proxy, `net.ts` gives
`curl`/`wget` a browser-`fetch`-backed implementation (subject to the
browser's CORS rules — nothing is proxied there), and `python.ts` registers
`python`, lazily downloading Pyodide on first use. `status.ts` powers the
file-tree's dirty/staged indicators. `ofx-cli`'s `workspace_tools` probe has
no equivalent here yet — the demo tells the model about `gh`, `curl` and
`python` by hand when it builds the wasm config.

### `apps/web` (the demo)

A Vite + React SPA plus a Cloudflare Worker.

- `src/workspace.ts` builds a `@wowsm/git` workspace and hands it to
  `src/ofx.ts`, which loads the wasm build and wraps `OfxAgent` with a
  TypeScript-friendly API.
- `src/components/Terminal.tsx` renders the session in `xterm.js`;
  `FileTree.tsx`, `SidePanel.tsx` and `SettingsPanel.tsx` round out the UI for
  browsing the cloned repo and configuring a provider/model/key
  (`settings.ts` persists that choice).
- `worker/index.ts` is the one Worker that serves everything: static assets
  for anything that isn't an API route, `worker/auth.ts` (Better Auth, GitHub
  OAuth, backed by D1 via `worker/schema.ts`) under `/api/auth`,
  `worker/git-proxy.ts` under `/api/git`, which relays git's smart-HTTP
  protocol to an allowlisted set of hosts since browsers cannot reach it
  directly, and `worker/gh-proxy.ts` under `/api/gh`, which does the same for
  the GitHub REST API so the browser never needs to hold a token to use `gh`.
  Signed-in requests get their GitHub token injected server-side from D1; the
  browser only ever holds a short-lived JWT, so the real credential never
  crosses the network to the client.

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
