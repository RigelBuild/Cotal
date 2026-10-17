// Kill only a process this suite can prove it owns. A pid read from a record, a host's stdout or
// /proc is pinned to its start token when read, and the SIGKILL goes through a pidfd opened on it
// only while that token still matches, so a recycled pid is never signalled. No numeric or group
// process.kill. Mirrors `killOwned` in packages/seat/smoke/lifecycle.smoke.ts.
import { closeSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { processStartToken } from "@cotal-ai/seat";
import { pidfdOpen, pidfdSignal } from "../../../packages/seat/dist/peercred.js";

export interface Owned {
  pid: number;
  start: string | undefined;
}

/** Pin `pid` to its start token now. Undefined for a pid this suite must never signal. */
export function owned(pid: number | undefined, start?: string): Owned | undefined {
  if (typeof pid !== "number" || pid <= 1) return undefined;
  return { pid, start: start ?? processStartToken(pid) };
}

export function killOwned(o: Owned | undefined): void {
  if (o === undefined || o.pid <= 1 || o.start === undefined) return;
  const fd = pidfdOpen(o.pid);
  if (fd === undefined) return;
  try {
    if (processStartToken(o.pid) === o.start) pidfdSignal(fd, "SIGKILL");
  } catch {
    /* already gone */
  } finally {
    closeSync(fd);
  }
}

/** SIGKILL a process this suite spawned, through its own ChildProcess handle, and await its exit. */
export async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}
