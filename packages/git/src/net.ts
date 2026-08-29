/** Matches just-bash's `SecureFetch` without importing its internal types. */
export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
}

export interface BrowserFetchOptions {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface CreateBrowserFetchOptions {
  /** Override the underlying fetch. Used by tests. */
  fetch?: typeof fetch;
  /** Rewrite a URL before the request, e.g. to route it through a proxy. */
  rewrite?: (url: string) => string;
}

/**
 * A `fetch` for just-bash's `curl`, backed by the browser.
 *
 * The browser's same-origin policy applies: a site is reachable only if it
 * sends `Access-Control-Allow-Origin`. Many APIs do; most web pages do not.
 * That is a property of running inside a tab, not something this can work
 * around — so the failure is reported plainly rather than as the browser's
 * bare "Failed to fetch".
 *
 * Requests go straight from the page. Nothing is proxied, so this cannot be
 * used to reach hosts the browser itself could not.
 */
export function createBrowserFetch(options: CreateBrowserFetchOptions = {}) {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  return async function browserFetch(
    url: string,
    init: BrowserFetchOptions = {},
  ): Promise<FetchResult> {
    let response: Response;
    try {
      response = await doFetch(options.rewrite ? options.rewrite(url) : url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: init.followRedirects === false ? "manual" : "follow",
        signal: init.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // A cross-origin request without CORS headers rejects with an opaque
      // TypeError that names neither the cause nor the host.
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // Leave the URL as given when it will not parse.
      }
      throw new Error(
        `curl: (7) could not reach ${host} — the browser blocked it. ` +
          `A page can only call hosts that send Access-Control-Allow-Origin.`,
      );
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: new Uint8Array(await response.arrayBuffer()),
      url: response.url || url,
    };
  };
}
