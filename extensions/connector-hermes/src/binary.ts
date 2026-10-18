import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Operator setting: the `hermes` executable the gateway runs, instead of the connector's
 *  project-pinned `uv run --project <connector> hermes`. Machine-wide, like `COTAL_CODEX_BIN`. */
export const HERMES_BIN_ENV = "COTAL_HERMES_BIN";

/** The exact `uv` executable resolved by manager boot. A bare fallback remains for library
 * compositions that do not run the installed-extension inventory. */
export function hermesUvCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_HERMES_UV_BIN?.trim() || "uv";
}

/** The argv that runs `hermes <args>`: the operator's {@link HERMES_BIN_ENV} executable when set,
 *  else the project-pinned Hermes through the exact manager-resolved uv. */
export function hermesCommand(env: NodeJS.ProcessEnv, pkgDir: string, args: readonly string[]): { command: string; args: string[] } {
  const bin = env[HERMES_BIN_ENV]?.trim();
  if (bin) return { command: bin, args: [...args] };
  return { command: hermesUvCommand(env), args: ["run", "--project", pkgDir, "hermes", ...args] };
}

/** Spawn the Hermes gateway: the operator's executable when set, else the project-pinned one. The
 * injectable spawn function is a smoke seam over this real call, not a second launch renderer. */
export function spawnHermesGateway(opts: {
  pkgDir: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}): ChildProcess {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const spawnOptions: SpawnOptions = { env: opts.env, stdio: "inherit" };
  const gateway = hermesCommand(opts.env, opts.pkgDir, ["gateway", "run"]);
  return spawnImpl(gateway.command, gateway.args, spawnOptions);
}
