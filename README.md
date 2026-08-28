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
pnpm dev
```

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-pack`. The workspace is a
virtual filesystem in the tab, persisted to IndexedDB: clone a real repository into it,
then run `ofx` against it. Git is [just-git](https://github.com/blindmansion/just-git) and
the shell is [just-bash](https://github.com/vercel-labs/just-bash), both pure TypeScript.
Cloning goes through a CORS proxy because browsers cannot reach GitHub's git endpoints
directly.

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
