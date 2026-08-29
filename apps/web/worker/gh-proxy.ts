import type { Env } from "./env.js";
import { corsHeaders, resolveGitHubToken } from "./git-proxy.js";

const API_ORIGIN = "https://api.github.com";

/** Response headers worth passing back; the rest are dropped. */
const KEEP_RESPONSE_HEADERS = new Set([
  "content-type",
  "link",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-oauth-scopes",
]);

/**
 * Proxy the GitHub REST API, attaching the caller's credentials.
 *
 * `api.github.com` does send CORS headers, so the browser could reach it
 * directly — but only with a token in the page. Routing through here keeps the
 * credential on the server, exactly as the git proxy does. Anonymous requests
 * are forwarded unauthenticated, so public data still works signed out.
 */
export async function handleGhProxy(request: Request, env: Env, origin: string): Promise<Response> {
  const requestOrigin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(requestOrigin) });
  }

  const url = new URL(request.url);
  const path = url.pathname.slice("/api/gh/".length);
  if (!path) {
    return new Response("expected /api/gh/<endpoint>", {
      status: 400,
      headers: corsHeaders(requestOrigin),
    });
  }

  const upstream = new URL(`${API_ORIGIN}/${path}`);
  upstream.search = url.search;

  const headers = new Headers({
    accept: request.headers.get("accept") ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ofx",
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const token = await resolveGitHubToken(request, env, origin);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  const responseHeaders = new Headers(corsHeaders(requestOrigin));
  for (const [name, value] of response.headers) {
    if (KEEP_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  // Lets the client report whether it is acting as a user or anonymously.
  responseHeaders.set("x-ofx-authenticated", token ? "true" : "false");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
