export interface Env {
  /** Static assets binding, provided by the `assets` config. */
  ASSETS: Fetcher;
  DB: D1Database;
  /** Signing/encryption secret. `wrangler secret put BETTER_AUTH_SECRET`. */
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Public origin, e.g. https://ofx.haxzie.workers.dev. */
  BETTER_AUTH_URL?: string;
}
