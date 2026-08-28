/**
 * Stub for `node:zlib`, statically imported by just-bash's browser build
 * (vercel-labs/just-bash#81). It backs only the `gzip`, `gunzip` and `zcat`
 * commands, which this app does not use.
 */
function unsupported(name: string): never {
  throw new Error(`${name} is unavailable in the browser workspace (node:zlib is not bundled)`);
}

export const constants = {} as Record<string, number>;
export function gzipSync(): never {
  return unsupported("gzip");
}
export function gunzipSync(): never {
  return unsupported("gunzip");
}
export default { constants, gzipSync, gunzipSync };
