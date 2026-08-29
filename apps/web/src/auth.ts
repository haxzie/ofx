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

export function signInWithGitHub(): void {
  // A full-page redirect rather than a popup: no window-messaging to babysit,
  // and the session cookie is set on the way back.
  const callback = encodeURIComponent(window.location.origin);
  window.location.href = `${AUTH_BASE}/sign-in/social?provider=github&callbackURL=${callback}`;
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
