import { createAuth } from "./auth.js";
import type { Env } from "./env.js";
import { handleGhProxy } from "./gh-proxy.js";
import { handleGitProxy } from "./git-proxy.js";

/**
 * One Worker serves the whole app: static assets, the auth API, and the git
 * proxy. Assets are matched first by the runtime, so this only sees requests
 * that did not resolve to a file.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.BETTER_AUTH_URL ?? url.origin;

    if (url.pathname.startsWith("/api/git/")) {
      return handleGitProxy(request, env, origin);
    }

    if (url.pathname.startsWith("/api/gh/")) {
      return handleGhProxy(request, env, origin);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      if (!env.GITHUB_CLIENT_ID || !env.BETTER_AUTH_SECRET) {
        return Response.json(
          { error: "auth is not configured on this deployment" },
          { status: 503 },
        );
      }
      return createAuth(env, origin).handler(request);
    }

    // Anything else is the SPA.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
