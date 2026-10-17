import { closeSync, constants, existsSync, fsyncSync, ftruncateSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { assertSeatId, fencePath, readRecord, recordPath, socketPath, type SeatRecord } from "./record.js";
import { RUN_MARKER_FLAG } from "./launcher.js";
import { CONFIRM_TIMEOUT_MS, unsupportedTransport } from "./protocol.js";
import { SeatClient } from "./client.js";
import { tryLockFd } from "./peercred.js";

/** A layer 3 seat cgroup. T5 builds it; until then a release that names one refuses. */
export interface SeatCgroup { readonly path: string; readonly agentUid: number }

/** `unprovable`: nothing on this host can prove the seat's processes gone. `members-remain`: a
 *  contained seat cgroup still held tasks at the bound. */
export type SeatRetainReason = "unprovable" | "members-remain";

export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: SeatRetainReason; stop: "requested" | "no-custodian" | "timeout"; detail: string };

export interface SeatReapOpts {
  graceMs?: number;
}

type StopResult = { stop: "requested" | "no-custodian" | "timeout"; error?: string };

// The stop goes to the derived socket path, never to a pid from the record; the custodian sends it
// through its own pinned handle.
async function requestStop(root: string, id: string, record: SeatRecord, timeoutMs: number): Promise<StopResult> {
  const client = new SeatClient({ ...record, socket: socketPath(root, id) });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<StopResult>((resolve) => {
    timer = setTimeout(() => resolve({ stop: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      client.connect().then(async (): Promise<StopResult> => {
        await client.stop("hard");
        return { stop: "requested" };
      }),
      timeout,
    ]);
  } catch (e) {
    // A refused hello or stop lands here too; keep its message so the evidence does not hide it.
    return { stop: "no-custodian", error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

/** One live custodian as a census sees it: its pid and the run that started it. */
export interface CustodianSighting {
  pid: number;
  run: string;
}

/**
 * Every live seat custodian on this host, with the run that started it (#1648).
 *
 * This reads `/proc/<pid>/cmdline` only, which is world-readable, so a census costs one readdir plus
 * one small read per pid and never needs the uid of the process it is looking at. That is the whole
 * reason the marker is on argv: the orphans carried their worktree only as their CWD, and
 * `/proc/<pid>/cwd` is a readlink the owner alone may follow, so a census of somebody else's
 * leftovers could not even see them.
 *
 * `run` filters to one run's custodians. Omitted, it reports every one on the host, which is what a
 * reaper sweeping before a run wants. A custodian started before this change carries no marker and
 * is not reported: it cannot be attributed, and claiming it as the caller's would be a guess.
 */
export function censusCustodians(run?: string): CustodianSighting[] {
  if (process.platform !== "linux") throw unsupportedTransport();
  const out: CustodianSighting[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // exited between the readdir and the read, or not ours to read
    }
    const argv = cmdline.split("\0").filter((s) => s.length > 0);
    // Both halves are required. The entry path alone matches any process whose argv happens to name
    // the file; the marker alone would match this package's own tests.
    if (!argv.some((a) => a.endsWith("/dist/custodian.js"))) continue;
    const at = argv.indexOf(RUN_MARKER_FLAG);
    if (at < 0) continue;
    const marker = argv[at + 1];
    if (marker === undefined) continue;
    if (run !== undefined && marker !== run) continue;
    out.push({ pid, run: marker });
  }
  return out;
}

/** Reap one seat. With no contained seat cgroup it sends no signal and never returns `reaped`: a
 *  record's pids and start tokens are agent-writable, so they can neither aim a send nor prove an exit. */
export async function reapSeat(root: string, id: string, opts: SeatReapOpts = {}): Promise<SeatReapEvidence> {
  if (process.platform !== "linux") throw unsupportedTransport();
  const path = recordPath(root, id);
  let rec: SeatRecord;
  try {
    rec = readRecord(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent" };
    return {
      outcome: "retained",
      reason: "unprovable",
      stop: "no-custodian",
      detail: `seat ${id} record at ${path} is unreadable: ${(e as Error).message}`,
    };
  }

  const { stop, error } = await requestStop(root, id, rec, opts.graceMs ?? 10_000);
  return {
    outcome: "retained",
    reason: "unprovable",
    stop,
    detail: `seat ${id} has no contained cgroup proof; stop ${stop}${error ? ` (${error})` : ""}`,
  };
}

export type SeatReleaseCheck = { ok: true; advisory: string } | { ok: false; reason: "populated" | "launch-in-progress"; detail: string };

// Layer 3 is not built yet, so a caller that names a cgroup gets a refusal rather than a silent no-op.
function refuseCgroup(opts: { cgroup?: SeatCgroup } | undefined): void {
  if (opts?.cgroup !== undefined) throw new Error(`seat cgroup ${opts.cgroup.path}: layer 3 release is not supported by this build`);
}

function releaseAdvisory(root: string, id: string): string {
  const census = process.platform === "linux" ? censusCustodians().length : 0;
  return `advisory, not proof: seat directory ${existsSync(join(root, id)) ? "present" : "absent"}; ${census} live custodian(s) on this host`;
}

/** Read-only: a fence another open file holds locked is a launch still in progress. */
export function checkSeatRelease(root: string, id: string, opts?: { cgroup?: SeatCgroup }): SeatReleaseCheck {
  if (process.platform !== "linux") throw unsupportedTransport();
  refuseCgroup(opts);
  const fence = fencePath(root, id);
  let fd: number;
  try {
    fd = openSync(fence, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, advisory: releaseAdvisory(root, id) };
    throw e;
  }
  try {
    if (!tryLockFd(fd)) return { ok: false, reason: "launch-in-progress", detail: `seat ${id} launch fence ${fence} is locked by a launch in progress` };
  } finally {
    closeSync(fd);
  }
  return { ok: true, advisory: releaseAdvisory(root, id) };
}

/** Seal the launch fence under its lock, so no launcher or custodian of this id can start a child. */
export async function sealSeatLaunch(root: string, id: string, opts?: { cgroup?: SeatCgroup }): Promise<SeatReleaseCheck> {
  if (process.platform !== "linux") throw unsupportedTransport();
  refuseCgroup(opts);
  const fence = fencePath(root, id);
  const fd = openSync(fence, constants.O_RDWR | constants.O_CREAT, 0o644);
  try {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (!tryLockFd(fd)) {
      if (Date.now() >= deadline) return { ok: false, reason: "launch-in-progress", detail: `seat ${id} launch fence ${fence} stayed locked for ${CONFIRM_TIMEOUT_MS}ms; a launch is in progress` };
      await sleep(25);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, "sealed", 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(root, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
  return { ok: true, advisory: releaseAdvisory(root, id) };
}

/** Remove the seat directory by rename, then delete the tombstone. The sealed fence stays. */
export function removeSeatCustody(root: string, id: string): void {
  const tombstone = join(root, `.released-${assertSeatId(id)}`);
  // A crash between rename and delete leaves a tombstone, and a rename onto it would fail.
  rmSync(tombstone, { recursive: true, force: true });
  try {
    renameSync(join(root, id), tombstone);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  rmSync(tombstone, { recursive: true, force: true });
}
