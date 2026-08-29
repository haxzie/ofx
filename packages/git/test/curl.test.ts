import { describe, expect, it } from "vitest";
import { createBrowserFetch } from "../src/net.js";
import { createWorkspace } from "../src/workspace.js";

function respondWith(body: string, init: ResponseInit = {}) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(input), method: opts?.method ?? "GET" });
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("browser fetch adapter", () => {
  it("maps a response into just-bash's FetchResult shape", async () => {
    const { fn } = respondWith('{"ok":true}', {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
    });
    const result = await createBrowserFetch({ fetch: fn })("https://api.example.com/things");

    expect(result.status).toBe(201);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
  });

  it("forwards the method", async () => {
    const { fn, calls } = respondWith("");
    await createBrowserFetch({ fetch: fn })("https://x.test", { method: "POST", body: "hi" });
    expect(calls[0]!.method).toBe("POST");
  });

  it("explains a CORS rejection instead of surfacing 'Failed to fetch'", async () => {
    // This is what the browser throws for a cross-origin request with no
    // Access-Control-Allow-Origin: a TypeError naming neither cause nor host.
    const fn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(
      createBrowserFetch({ fetch: fn })("https://example.com/page"),
    ).rejects.toThrow(/could not reach example\.com.*Access-Control-Allow-Origin/s);
  });

  it("lets an abort propagate untouched", async () => {
    const fn = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;

    await expect(createBrowserFetch({ fetch: fn })("https://x.test")).rejects.toThrow(/aborted/);
  });

  it("can route requests through a rewrite", async () => {
    const { fn, calls } = respondWith("ok");
    await createBrowserFetch({
      fetch: fn,
      rewrite: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    })("https://blocked.test/data");

    expect(calls[0]!.url).toBe("/proxy?u=https%3A%2F%2Fblocked.test%2Fdata");
  });
});

describe("curl in the shell", () => {
  it("is registered and fetches through the adapter", async () => {
    const { fn } = respondWith("hello from the network");
    const ws = await createWorkspace({
      fs: { persist: false },
      corsProxy: null,
      curl: { fetch: fn },
    });

    const result = await ws.shell.run("curl https://api.example.com/greeting");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("hello from the network");
  });

  it("composes with the rest of the shell", async () => {
    const { fn } = respondWith('{"name":"ofx","stars":3}');
    const ws = await createWorkspace({
      fs: { persist: false },
      corsProxy: null,
      curl: { fetch: fn },
    });

    const result = await ws.shell.run("curl -s https://api.example.com/repo | jq -r .name");
    expect(result.stdout.trim()).toBe("ofx");
  });

  it("stays unregistered when curl is disabled", async () => {
    const ws = await createWorkspace({ fs: { persist: false }, corsProxy: null, curl: false });
    const result = await ws.shell.run("curl https://api.example.com");
    expect(result.exitCode).not.toBe(0);
  });
});
