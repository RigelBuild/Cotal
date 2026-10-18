import { closeSync, constants, existsSync, fsyncSync, ftruncateSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discardSeatArtifacts } from "./artifacts.js";
import { assertSeatId, bootToken, exitPath, fencePath, isSeatId, processStartToken, readRecord, readSeatFileNoFollow, recordPath, socketPath, type SeatRecord } from "./record.js";
import { RUN_MARKER_FLAG } from "./launcher.js";
import { CONFIRM_TIMEOUT_MS, GRACE_MS, unsupportedTransport, type SeatExit } from "./protocol.js";
import { SeatClient } from "./client.js";
import { tryLockFd } from "./peercred.js";
import { assertSeatCgroup, killSeatCgroup, removeSeatCgroup, seatCgroupContained, seatCgroupPopulated, type SeatCgroup } from "./cgroup.js";

/** `unprovable`: nothing on this host can prove the seat's processes gone. `members-remain`: a
 *  contained seat cgroup still held tasks at the bound. */
export type SeatRetainReason = "unprovable" | "members-remain";

export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; exit?: SeatExit; detail: string }
  | { outcome: "retained"; reason: SeatRetainReason; stop: "requested" | "no-custodian" | "timeout"; detail: string };

/** How the child ended, as its custodian recorded it; why a record that exists cannot be read; or
 *  neither when no record exists (the child was still running, or its custodian never wrote one).
 *  The seat directory may be agent-owned, so the read never follows a final symlink. */
function recordedExit(file: string): { exit?: SeatExit; unreadable?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readSeatFileNoFollow(file));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { unreadable: (e as Error).message };
  }
  if (typeof raw !== "object" || raw === null) return { unreadable: "not a JSON object" };
  const { code, signal, diagnostic } = raw as Record<string, unknown>;
  return {
    exit: {
      ...(Number.isInteger(code) ? { code: code as number } : {}),
      ...(Number.isInteger(signal) ? { signal: signal as number } : {}),
      ...(typeof diagnostic === "string" ? { diagnostic } : {}),
    },
  };
}

/** A pid's standing against a recorded start identity: a read of `/proc`, never a send. `live`
 *  only when the process exists AND carries the recorded start token. Advisory: a record's pids and
 *  tokens are agent-writable, so this can never prove an exit or aim a signal. */
export function identityVerdict(pid: number, start: string): "live" | "gone" {
  const now = processStartToken(pid);
  return now !== undefined && now === start ? "live" : "gone";
}

export interface SeatReapOpts {
  graceMs?: number;
  /** The seat's derived cgroup. Contained, it decides the outcome before `record.json` is read. */
  cgroup?: SeatCgroup;
}

// `undefined`: a concurrent reap or release removed the cgroup, so there is no seat cgroup to prove.
async function reapCgroup(id: string, cg: SeatCgroup, graceMs: number): Promise<SeatReapEvidence | undefined> {
  try {
    killSeatCgroup(cg);
    const deadline = Date.now() + graceMs;
    while (seatCgroupPopulated(cg) && Date.now() < deadline) await sleep(25);
    if (seatCgroupPopulated(cg)) throw new Error(`still reads populated 1 after ${graceMs}ms`);
    removeSeatCgroup(cg);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return { outcome: "retained", reason: "members-remain", stop: "no-custodian", detail: `seat ${id} cgroup ${cg.path}${code ? ` (${code})` : ""}: ${(e as Error).message}` };
  }
  return { outcome: "reaped", detail: `seat ${id} cgroup ${cg.path} killed, read populated 0 and was removed` };
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

/** Reap one seat. Only a contained seat cgroup can give `reaped`: a record's pids and start tokens
 *  are agent-writable, so they can neither aim a send nor prove an exit. */
export async function reapSeat(root: string, id: string, opts: SeatReapOpts = {}): Promise<SeatReapEvidence> {
  if (process.platform !== "linux") throw unsupportedTransport();
  const cg = opts.cgroup;
  if (cg !== undefined && existsSync(assertSeatCgroup(cg, id).path) && seatCgroupContained(cg)) {
    const evidence = await reapCgroup(id, cg, opts.graceMs ?? GRACE_MS);
    if (evidence?.outcome === "reaped") {
      const after = afterProvedGone(root, id);
      return { outcome: "reaped", ...(after.exit ? { exit: after.exit } : {}), detail: after.notes.length ? `${evidence.detail}; ${after.notes.join("; ")}` : evidence.detail };
    }
    if (evidence !== undefined) return evidence;
  }
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

/** Once a contained cgroup proved the seat gone: how its child ended, and the launch artifacts the
 *  record still lists. The record is agent-writable, so only artifacts under this process's own temp
 *  dir are removed; a record naming any other root is left for the operator. */
function afterProvedGone(root: string, id: string): { exit?: SeatExit; notes: string[] } {
  const path = recordPath(root, id);
  const recorded = recordedExit(exitPath(path));
  const notes: string[] = [];
  if (recorded.exit)
    notes.push(`its custodian recorded exit code ${recorded.exit.code ?? "unknown"}${recorded.exit.signal === undefined ? "" : `, signal ${recorded.exit.signal}`}${recorded.exit.diagnostic ? `, diagnostic: ${recorded.exit.diagnostic}` : ""}`);
  else if (recorded.unreadable !== undefined) notes.push(`its custodian's exit record is unreadable: ${recorded.unreadable}`);
  let latest: SeatRecord | undefined;
  try {
    latest = readRecord(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") notes.push(`record unreadable, launch artifacts not removed: ${(e as Error).message}`);
  }
  if (latest?.artifacts?.length) {
    const own = resolve(tmpdir());
    try {
      if (latest.artifactRoot === undefined || resolve(latest.artifactRoot) !== own)
        throw new Error(`record names artifact root ${String(latest.artifactRoot)}, not ${own}`);
      discardSeatArtifacts(latest.artifacts, own);
    } catch (e) {
      notes.push(`launch artifacts not removed: ${(e as Error).message}`);
    }
  }
  return { ...(recorded.exit ? { exit: recorded.exit } : {}), notes };
}

export type SeatReleaseCheck = { ok: true; advisory: string } | { ok: false; reason: "populated" | "launch-in-progress"; detail: string };

/** Test seam: pause a release between its `populated 0` read and its `rmdir`. */
export interface ReleaseTestSeam {
  afterPopulated?: { reached: string; release: string };
}
let releaseSeam: ReleaseTestSeam | undefined;
export function setReleaseTestSeam(seam: ReleaseTestSeam | undefined): void {
  releaseSeam = seam;
}

function populatedRefusal(id: string, cg: SeatCgroup, why: string): SeatReleaseCheck {
  return { ok: false, reason: "populated", detail: `seat ${id} cgroup ${cg.path} ${why}; a member could start the seat again` };
}

// A cgroup that is already gone is empty: nothing can join a path that no longer exists.
function readsPopulated(cg: SeatCgroup): boolean {
  try {
    return seatCgroupPopulated(cg);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Under the fence lock: an empty seat cgroup is removed, so a later join fails with `ENOENT`. */
async function removeEmptyCgroup(id: string, cg: SeatCgroup): Promise<SeatReleaseCheck | undefined> {
  if (readsPopulated(cg)) return populatedRefusal(id, cg, "reads populated 1");
  const hold = releaseSeam?.afterPopulated;
  if (hold) {
    writeFileSync(hold.reached, String(process.pid));
    const holdBy = Date.now() + CONFIRM_TIMEOUT_MS;
    while (!existsSync(hold.release)) {
      if (Date.now() >= holdBy) throw new Error("test seam release hold was never released");
      await sleep(25);
    }
  }
  try {
    removeSeatCgroup(cg);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY") return populatedRefusal(id, cg, "refused rmdir with EBUSY");
    if (code !== "ENOENT") throw e;
  }
  return undefined;
}

function releaseAdvisory(root: string, id: string): string {
  const census = process.platform === "linux" ? censusCustodians().length : 0;
  return `advisory, not proof: seat directory ${existsSync(join(root, id)) ? "present" : "absent"}; ${census} live custodian(s) on this host`;
}

/** Read-only: a fence another open file holds locked is a launch still in progress, and a populated
 *  seat cgroup is a seat that still runs. */
export function checkSeatRelease(root: string, id: string, opts?: { cgroup?: SeatCgroup }): SeatReleaseCheck {
  if (process.platform !== "linux") throw unsupportedTransport();
  const cg = opts?.cgroup === undefined ? undefined : assertSeatCgroup(opts.cgroup, id);
  if (cg !== undefined && readsPopulated(cg)) return populatedRefusal(id, cg, "reads populated 1");
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

/** Seal the launch fence under its lock, so no launcher or custodian of this id can start a child.
 *  An empty seat cgroup is removed first, under the same lock; a populated one refuses. */
export async function sealSeatLaunch(root: string, id: string, opts?: { cgroup?: SeatCgroup }): Promise<SeatReleaseCheck> {
  if (process.platform !== "linux") throw unsupportedTransport();
  const cg = opts?.cgroup === undefined ? undefined : assertSeatCgroup(opts.cgroup, id);
  const fence = fencePath(root, id);
  const fd = openSync(fence, constants.O_RDWR | constants.O_CREAT, 0o644);
  try {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (!tryLockFd(fd)) {
      if (Date.now() >= deadline) return { ok: false, reason: "launch-in-progress", detail: `seat ${id} launch fence ${fence} stayed locked for ${CONFIRM_TIMEOUT_MS}ms; a launch is in progress` };
      await sleep(25);
    }
    const refusal = cg === undefined ? undefined : await removeEmptyCgroup(id, cg);
    if (refusal !== undefined) return refusal;
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

/** Why `rec`'s pids cannot be tied to the processes it recorded, or undefined when they can. A
 *  start token counts ticks since ITS OWN boot, so it only tells two processes apart within one boot,
 *  and a record may have outlived a reboot on disk. A record with no start identity or no boot
 *  identity proves nothing about whatever holds those pid numbers now, and neither does any record
 *  while this host's own `boot` is unknown, so such a record is never reported as running or gone. */
function unprovedIdentity(id: string, rec: SeatRecord, boot: string | undefined): string | undefined {
  if (rec.custodianStart === undefined)
    return `seat ${id} record carries no process start identity; pid ${rec.custodianPid}/${rec.childPid} may belong to an unrelated process`;
  if (rec.bootId === undefined)
    return `seat ${id} record carries no boot identity; pid ${rec.custodianPid}/${rec.childPid} start tokens cannot be compared across a reboot`;
  if (boot === undefined)
    return `seat ${id}: this host publishes no boot identity; record boot ${rec.bootId} for pid ${rec.custodianPid}/${rec.childPid} cannot be tied to this boot`;
  return undefined;
}

/** One custody record as {@link drainSeats} found it. `live-child`: the child still holds its
 *  recorded start identity, so the seat is a running agent and is never stopped. `childless`: the
 *  child is gone, so a drain would retire the seat. `drained`: a drain proved the seat gone.
 *  `refused`: the record could not be read, carries no start or boot identity, this host publishes
 *  no boot identity, or the reap did not prove the seat gone; the record stays on disk. */
export interface SeatInventoryEntry {
  id: string;
  state: "live-child" | "childless" | "drained" | "refused";
  name?: string;
  custodianPid?: number;
  childPid?: number;
  detail: string;
}

/**
 * List the custody records under `root`, and with `drain` retire every seat whose child is gone
 * (#1391).
 *
 * The listing only reads `/proc`; it never sends a signal. A seat whose child still holds its
 * recorded start identity is reported and left alone. Only a seat whose child reads gone reaches
 * {@link reapSeat}, which proves nothing without a contained seat cgroup, so such a drain asks the
 * custodian to stop through its socket and reports the retained seat as `refused` for the operator.
 */
export async function drainSeats(root: string, opts: { drain?: boolean; graceMs?: number } = {}): Promise<SeatInventoryEntry[]> {
  if (process.platform !== "linux") throw unsupportedTransport();
  let ids: string[];
  try {
    ids = readdirSync(root).filter(isSeatId).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const boot = bootToken();
  const out: SeatInventoryEntry[] = [];
  for (const id of ids) {
    let rec: SeatRecord;
    try {
      rec = readRecord(recordPath(root, id));
    } catch (e) {
      out.push({ id, state: "refused", detail: `record unreadable: ${(e as Error).message}` });
      continue;
    }
    const seen = { id, name: rec.name, custodianPid: rec.custodianPid, childPid: rec.childPid };
    const unproved = unprovedIdentity(id, rec, boot);
    if (unproved !== undefined) {
      out.push({ ...seen, state: "refused", detail: unproved });
      continue;
    }
    // No process outlives a reboot, so a record from an earlier boot names only gone processes.
    const earlierBoot = rec.bootId !== boot;
    if (!earlierBoot && rec.childStart !== undefined && identityVerdict(rec.childPid, rec.childStart) === "live") {
      out.push({ ...seen, state: "live-child", detail: `child ${rec.childPid} is running; kept` });
      continue;
    }
    if (!opts.drain) {
      const custodian = !earlierBoot && rec.custodianStart !== undefined && identityVerdict(rec.custodianPid, rec.custodianStart) === "live" ? "running" : "gone";
      out.push({ ...seen, state: "childless", detail: `child ${rec.childPid} is gone; custodian ${rec.custodianPid} ${custodian}${earlierBoot ? ` with boot ${rec.bootId}` : ""}` });
      continue;
    }
    try {
      const evidence = await reapSeat(root, id, opts.graceMs === undefined ? {} : { graceMs: opts.graceMs });
      out.push(
        evidence.outcome === "reaped"
          ? { ...seen, state: "drained", detail: evidence.detail }
          : evidence.outcome === "retained"
            ? { ...seen, state: "refused", detail: `retained (${evidence.reason}): ${evidence.detail}` }
            : { ...seen, state: "refused", detail: "record vanished before the reap; nothing was stopped" },
      );
    } catch (e) {
      out.push({ ...seen, state: "refused", detail: (e as Error).message });
    }
  }
  return out;
}
