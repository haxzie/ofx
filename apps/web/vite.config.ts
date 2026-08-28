import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // just-bash's browser entry still statically imports node:zlib
      // (vercel-labs/just-bash#81). It backs only gzip/gunzip/zcat, which we
      // don't use, so it resolves to a stub that fails loudly if called.
      "node:zlib": fileURLToPath(new URL("./src/shims/zlib.ts", import.meta.url)),
      // The wasm package is build output, not a dependency: aliasing it keeps
      // `pnpm install` working on a fresh clone, before wasm-pack has run.
      "ofx-wasm": fileURLToPath(
        new URL("../../packages/ofx/crates/ofx-wasm/pkg/ofx_wasm.js", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    // just-bash must be pre-bundled, not excluded: it pulls in CJS packages
    // (sprintf-js) that only the optimizer converts to ESM.
    include: ["just-bash/browser", "just-git", "just-git/proxy"],
  },
});
