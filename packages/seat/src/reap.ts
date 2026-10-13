import { readdirSync, readFileSync } from "node:fs";
import { readRecord, recordPath, socketPath, type SeatRecord } from "./record.js";
import { RUN_MARKER_FLAG } from "./launcher.js";
import { unsupportedTransport } from "./protocol.js";
import { SeatClient } from "./client.js";

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

// The stop goes to the derived socket path, never to a pid from the record; the custodian sends it
// through its own pinned handle.
async function requestStop(root: string, id: string, record: SeatRecord, timeoutMs: number): Promise<"requested" | "no-custodian" | "timeout"> {
  const client = new SeatClient({ ...record, socket: socketPath(root, id) });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([
      client.connect().then(async () => {
        await client.stop("hard");
        return "requested" as const;
      }),
      timeout,
    ]);
  } catch {
    return "no-custodian";
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

  const stop = await requestStop(root, id, rec, opts.graceMs ?? 10_000);
  return {
    outcome: "retained",
    reason: "unprovable",
    stop,
    detail: `seat ${id} has no contained cgroup proof; stop ${stop}`,
  };
}
