import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env.js";
import * as schema from "./schema.js";

/**
 * Better Auth is built per request: its database comes from a Worker binding,
 * which only exists once a request is in flight.
 *
 * The return type is inferred rather than annotated — Better Auth threads the
 * options through its generics, and widening to `Auth<BetterAuthOptions>`
 * discards the plugin and provider types.
 */
export function createAuth(env: Env, origin: string) {
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? origin,
    basePath: "/api/auth",
    account: {
      // GitHub tokens carry push access, so they are encrypted at rest in D1
      // rather than stored in the clear.
      encryptOAuthTokens: true,
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // `repo` is what lets the git proxy clone private repositories and
        // push on the user's behalf.
        scope: ["repo"],
      },
    },
    // Issues the short-lived JWT the browser presents to the git proxy.
    plugins: [jwt()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
