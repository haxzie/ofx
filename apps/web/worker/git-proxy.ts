import { symmetricDecrypt } from "better-auth/crypto";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as jose from "jose";
import type { Env } from "./env.js";
import * as schema from "./schema.js";

/**
 * Hosts this proxy will forward to. Without an allowlist the Worker is an open
 * relay that anyone can point at any origin.
 */
const ALLOWED_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);

/** Only the git smart-HTTP endpoints, so this cannot be used as a general proxy. */
const ALLOWED_PATHS = [/\/info\/refs$/, /\/git-upload-pack$/, /\/git-receive-pack$/];

/** Hop-by-hop and identifying headers that must not be forwarded upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "origin",
  "referer",
  "cookie",
  "connection",
  "content-length",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "transfer-encoding",
  "content-encoding",
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, pragma, user-agent",
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "content-type, content-length",
  };
}

/**
 * Resolve the caller's GitHub token, or null when the request is anonymous.
 *
 * The browser presents a Better Auth JWT rather than a GitHub token: the real
 * credential never leaves the Worker. The JWT is verified against Better
 * Auth's own JWKS, then the encrypted token is read from D1 and decrypted here.
 */
export async function resolveGitHubToken(request: Request, env: Env, origin: string): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  let userId: string;
  try {
    const jwks = jose.createRemoteJWKSet(new URL("/api/auth/jwks", origin));
    const { payload } = await jose.jwtVerify(token, jwks);
    if (!payload.sub) return null;
    userId = payload.sub;
  } catch {
    // An invalid or expired JWT degrades to anonymous rather than failing the
    // request: public clones should still work.
    return null;
  }

  const db = drizzle(env.DB, { schema });
  const rows = await db
    .select({ accessToken: schema.account.accessToken })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .limit(1);

  const stored = rows[0]?.accessToken;
  if (!stored) return null;

  try {
    return await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: stored });
  } catch {
    // Written before encryption was enabled, or under a different secret.
    return null;
  }
}

/**
 * Proxy git smart-HTTP to an upstream host, adding the caller's credentials.
 *
 * Browsers cannot speak to GitHub's git endpoints directly — they answer the
 * CORS preflight with a 405 — so this stands in. Requests are matched as
 * `/api/git/<host>/<path...>`.
 */
export async function handleGitProxy(request: Request, env: Env, origin: string): Promise<Response> {
  const requestOrigin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(requestOrigin) });
  }

  const url = new URL(request.url);
  const rest = url.pathname.slice("/api/git/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return new Response("expected /api/git/<host>/<path>", { status: 400 });
  }

  const host = rest.slice(0, slash);
  const path = rest.slice(slash);

  if (!ALLOWED_HOSTS.has(host)) {
    return new Response(`host not allowed: ${host}`, {
      status: 403,
      headers: corsHeaders(requestOrigin),
    });
  }
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    return new Response("only git smart-HTTP endpoints are proxied", {
      status: 403,
      headers: corsHeaders(requestOrigin),
    });
  }

  const upstream = new URL(`https://${host}${path}`);
  upstream.search = url.search;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // GitHub varies its behaviour on User-Agent and wants a git-like one.
  if (!headers.has("user-agent")) headers.set("user-agent", "git/ofx-proxy");

  const githubToken = await resolveGitHubToken(request, env, origin);
  if (githubToken) {
    // Basic with the token as password is what GitHub expects for both
    // classic and fine-grained tokens.
    headers.set("authorization", `Basic ${btoa(`x-access-token:${githubToken}`)}`);
  }

  const upstreamResponse = await fetch(upstream, {
    method: request.method,
    headers,
    // Packfiles are large; streaming avoids buffering them in the Worker.
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });

  const responseHeaders = new Headers(corsHeaders(requestOrigin));
  for (const [name, value] of upstreamResponse.headers) {
    if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
