/**
 * Standalone sidecar entry — bundled (esbuild → dist/standalone.cjs) and spawned by the Python
 * plugin when a user runs their OWN Hermes (`hermes plugins install cotal-ai/<repo> --enable`).
 *
 * In that mode there is no Cotal launcher: the enabled plugin sees COTAL_SPACE / COTAL_NAME /
 * COTAL_SERVERS but no bridge socket, so it derives the socket/file paths, sets them in the
 * sidecar's env, and spawns this. We just bring up the mesh + bridge + control + tools file and
 * stay alive for the gateway's lifetime — the gateway itself is already running around us, so
 * (unlike launch.ts) we never spawn a `hermes` child.
 */
import { startSidecar } from "./sidecar.js";

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes/standalone] ${msg}\n`);
}

const sidecar = startSidecar();
log(`mesh sidecar up for ${sidecar.config.name} in space ${sidecar.config.space}`);

let stopping = false;
let parentWatch: ReturnType<typeof setInterval> | undefined;
const stop = async (code: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (parentWatch) clearInterval(parentWatch);
  try {
    await sidecar.stop();
  } finally {
    process.exit(code);
  }
};

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

// A sidecar must never outlive the gateway that spawned it: an orphan keeps publishing presence as
// a phantom `${name}` peer AND keeps pulling the shared mesh inbox, so a peer that resolves the
// phantom DMs a black hole that never replies. The gateway doesn't always signal us on
// restart/crash.
//
// We watch the EXACT pid of the launching gateway (COTAL_PARENT_PID), probed with a signal-0
// liveness check. This is robust where ppid is not: the official container image boots the gateway
// twice (a transient CMD `gateway run` hands off to the supervised service), and a sidecar can be
// reparented to an unrelated process before we ever read ppid — so "ppid changed" never fires.
// Watching the explicit launcher pid follows the right process regardless of reparenting; the ppid
// check stays as a cheap backstop for any launcher that didn't set COTAL_PARENT_PID.
const launcherPid = Number(process.env.COTAL_PARENT_PID) || undefined;
const initialPpid = process.ppid;
const launcherGone = () => {
  if (launcherPid === undefined) return false;
  try {
    process.kill(launcherPid, 0);
    return false;
  } catch {
    return true;
  }
};
parentWatch = setInterval(() => {
  if (launcherGone()) {
    log(`launching gateway (pid ${launcherPid}) is gone — stopping sidecar to avoid an orphan`);
    void stop(0);
  } else if (launcherPid === undefined && process.ppid !== initialPpid) {
    log(`parent gateway (${initialPpid}) is gone — stopping sidecar to avoid an orphan`);
    void stop(0);
  }
}, 1000);
parentWatch.unref();
