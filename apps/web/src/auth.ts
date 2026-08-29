/**
 * Session and JWT handling.
 *
 * The browser never sees a GitHub token. It holds a Better Auth session cookie
 * and exchanges it for a short-lived JWT, which the git proxy verifies before
 * attaching the real credential server-side.
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

const AUTH_BASE = "/api/auth";

/** Current session, or null when signed out or auth is not configured. */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const response = await fetch(`${AUTH_BASE}/get-session`, { credentials: "include" });
    if (!response.ok) return null;
    const data = (await response.json()) as { user?: SessionUser } | null;
    return data?.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Begin the GitHub sign-in flow.
 *
 * Better Auth's social sign-in is a POST that answers with the provider URL to
 * visit — navigating straight at the endpoint returns 404. The redirect is a
 * full page load rather than a popup: nothing to babysit, and the session
 * cookie is set on the way back.
 */
export async function signInWithGitHub(): Promise<void> {
  const response = await fetch(`${AUTH_BASE}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      provider: "github",
      callbackURL: window.location.origin,
      errorCallbackURL: window.location.origin,
    }),
  });

  if (!response.ok) {
    throw new Error(`sign-in failed (${response.status})`);
  }
  const data = (await response.json()) as { url?: string; redirect?: boolean };
  if (!data.url) throw new Error("sign-in did not return a redirect URL");
  window.location.href = data.url;
}

export async function signOut(): Promise<void> {
  await fetch(`${AUTH_BASE}/sign-out`, { method: "POST", credentials: "include" });
}

let cached: { token: string; expiresAt: number } | null = null;

/**
 * A JWT for the git proxy, refreshed shortly before it expires.
 * Returns null when signed out, which the proxy treats as anonymous.
 */
export async function getGitToken(): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const response = await fetch(`${AUTH_BASE}/token`, { credentials: "include" });
    if (!response.ok) {
      cached = null;
      return null;
    }
    const data = (await response.json()) as { token?: string };
    if (!data.token) return null;

    // Refresh a minute early rather than parsing `exp` out of the payload.
    cached = { token: data.token, expiresAt: Date.now() + 4 * 60_000 };
    return data.token;
  } catch {
    return null;
  }
}

export function clearGitToken(): void {
  cached = null;
}
