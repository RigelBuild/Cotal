#!/usr/bin/env node
/** The reconciler shim process: `--socket` names the Go reconciler's socket, `--creds` the reconciler credential mount. */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runReconcilerShim, type SeatsServeBundle } from "./serve.js";

export const DEFAULT_SOCKET = "/run/cotal-reconciler/shim.sock";

export function parseShimArgs(argv: readonly string[]): { socketPath: string; credsPath: string } {
  const { values } = parseArgs({ args: [...argv], options: { socket: { type: "string" }, creds: { type: "string" } }, strict: true });
  if (!values.creds) throw new Error("--creds <path> is required: the reconciler credential mount");
  return { socketPath: values.socket ?? DEFAULT_SOCKET, credsPath: values.creds };
}

// TODO(RIG-11045, owner cotal-auth): read the serve bundle auth renews into the reconciler Secret.
function provisionServeBundle(_creds: string): Promise<SeatsServeBundle> {
  return Promise.reject(new Error("no serve bundle source is configured: auth does not deliver the serve bundle yet"));
}

async function main(): Promise<void> {
  const { socketPath, credsPath } = parseShimArgs(process.argv.slice(2));
  const bundle = await provisionServeBundle(readFileSync(credsPath, "utf8"));
  const shim = await runReconcilerShim(bundle, { socketPath });
  console.error(`reconciler-shim: serving ${shim.endpoint} instance ${shim.instanceId} epoch ${shim.epoch} via ${socketPath}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shim.stop());
  const closed = await shim.closed;
  if (closed) throw closed;
}

// The npm bin is a symlink, so compare against the resolved script path.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(`reconciler-shim: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
