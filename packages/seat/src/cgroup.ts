import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmdirSync, statfsSync, statSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { assertSeatId } from "./record.js";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** A layer 3 seat cgroup: `<base>/seat-<id>`, and the uid the seat's agent runs as. */
export interface SeatCgroup { readonly path: string; readonly agentUid: number }

export function seatCgroupPath(base: string, id: string): string {
  if (!base.startsWith(`${CGROUP_ROOT}/`)) throw new Error(`cgroup base ${base} is not under ${CGROUP_ROOT}`);
  return `${base}/seat-${assertSeatId(id)}`;
}

/** `mkdir` without `recursive`, so an existing seat cgroup throws `EEXIST`. */
export function createSeatCgroup(base: string, id: string, agentUid: number): SeatCgroup {
  const path = seatCgroupPath(base, id);
  mkdirSync(path);
  return { path, agentUid };
}

/** No `O_CREAT`: a seat cgroup a reap or release removed makes the move throw `ENOENT`. */
export function moveIntoSeatCgroup(cg: SeatCgroup, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to move pid ${pid} into seat cgroup ${cg.path}`);
  writeExisting(join(cg.path, "cgroup.procs"), String(pid));
}

function writeExisting(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export function inSeatCgroup(cg: Pick<SeatCgroup, "path">): boolean {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
  return line !== undefined && `${CGROUP_ROOT}${line.slice(3)}` === cg.path;
}

export function seatCgroupPopulated(cg: SeatCgroup): boolean {
  return /^populated 1$/m.test(readFileSync(join(cg.path, "cgroup.events"), "utf8"));
}

export function killSeatCgroup(cg: SeatCgroup): void {
  writeExisting(join(cg.path, "cgroup.kill"), "1");
}

/** `rmdir`: a populated cgroup throws `EBUSY`. */
export function removeSeatCgroup(cg: SeatCgroup): void {
  rmdirSync(cg.path);
}

function idList(flag: "-g" | "-G", uid: number): number[] | undefined {
  const r = spawnSync("id", [flag, String(uid)], { encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0) return undefined;
  const ids = r.stdout.trim().split(/\s+/).map(Number);
  return ids.length > 0 && ids.every((n) => Number.isInteger(n) && n >= 0) ? ids : undefined;
}

function writableBy(st: Stats, uid: number, groups: readonly number[]): boolean {
  if (st.mode & 0o002) return true;
  if (st.mode & 0o020 && groups.includes(st.gid)) return true;
  return st.uid === uid && (st.mode & 0o200) !== 0;
}

// Exit 10: a write landed, so the agent can migrate. Exit 11: every write was refused. Anything
// else (no setpriv, no CAP_SETUID, unknown user) is an attempt that never ran.
const MIGRATION_PROBE = 'for f; do if { echo $$ > "$f"; } 2>/dev/null; then exit 10; fi; done; exit 11';

/**
 * True only when the agent uid provably cannot write `cgroup.procs` at the base or any ancestor,
 * so it cannot leave the seat cgroup. Every check that cannot run reads as not contained.
 */
export function seatCgroupContained(cg: SeatCgroup): boolean {
  const uid = cg.agentUid;
  if (process.platform !== "linux" || !Number.isInteger(uid) || uid < 0) return false;
  // Root bypasses file modes, and a shared manager/agent uid owns the delegated base.
  if (uid === 0 || uid === process.geteuid?.()) return false;
  try {
    // cgroup2 kernfs supports no POSIX ACLs, so mode bits are the whole grant.
    if (statfsSync(CGROUP_ROOT).type !== CGROUP2_SUPER_MAGIC) return false;
  } catch {
    return false;
  }
  const groups = idList("-G", uid);
  const gid = idList("-g", uid)?.[0];
  if (groups === undefined || gid === undefined) return false;
  const procs: string[] = [];
  for (let dir = dirname(cg.path); ; dir = dirname(dir)) {
    if (dir !== CGROUP_ROOT && !dir.startsWith(`${CGROUP_ROOT}/`)) return false;
    const file = join(dir, "cgroup.procs");
    try {
      if (writableBy(statSync(file), uid, groups)) return false;
    } catch {
      return false;
    }
    procs.push(file);
    if (dir === CGROUP_ROOT) break;
  }
  const probe = spawnSync("setpriv", ["--reuid", String(uid), "--regid", String(gid), "--init-groups", "--", "sh", "-c", MIGRATION_PROBE, "sh", ...procs], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 11;
}
