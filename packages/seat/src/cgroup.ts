import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, statfsSync, statSync, writeSync, type Stats } from "node:fs";
import { dirname, join, posix } from "node:path";
import { assertSeatId } from "./record.js";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** A layer 3 seat cgroup: `<base>/seat-<id>`, and the uid the seat's agent runs as. */
export interface SeatCgroup { readonly path: string; readonly agentUid: number }

// A base or path that is not already normalized could name a cgroup other than the one it reads as.
function assertNormalUnderRoot(path: string, what: string): string {
  const normal = path === posix.normalize(path) && !path.endsWith("/") && !path.split("/").includes("..");
  if (!normal || !path.startsWith(`${CGROUP_ROOT}/`)) throw new Error(`${what} ${path} is not a normalized path below ${CGROUP_ROOT}`);
  return path;
}

/** This process's own cgroup: `/sys/fs/cgroup` plus the `0::` line of `/proc/self/cgroup`. For the
 *  manager it is the delegated base; for a custodian it is the cgroup it has joined. */
export function ownCgroup(): string | undefined {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
  return line === undefined ? undefined : `${CGROUP_ROOT}${line.slice(3)}`;
}

export function seatCgroupPath(base: string, id: string): string {
  return `${assertNormalUnderRoot(base, "cgroup base")}/seat-${assertSeatId(id)}`;
}

/** The manager's layer 3 base: its own cgroup, on cgroup2, whose directory, `cgroup.procs` and
 *  `cgroup.subtree_control` this euid can write. Undefined when any of that is not true. Decided from
 *  the filesystem alone: a privileged manager runs nothing to find it. */
export function resolveCgroupBase(): string | undefined {
  try {
    if (statfsSync(CGROUP_ROOT).type !== CGROUP2_SUPER_MAGIC) return undefined;
    const base = ownCgroup();
    if (base === undefined) return undefined;
    assertNormalUnderRoot(base, "cgroup base");
    for (const p of [base, join(base, "cgroup.procs"), join(base, "cgroup.subtree_control")]) accessSync(p, constants.W_OK);
    return base;
  } catch {
    return undefined;
  }
}

/** The agent uid's primary gid from `/etc/passwd`, read without running anything; for a uid not
 *  listed there, `COTAL_SEAT_AGENT_GID`. Undefined when neither names one. */
export function agentPrimaryGid(uid: number): number | undefined {
  let passwd = "";
  try {
    passwd = readFileSync("/etc/passwd", "utf8");
  } catch {
    // An unreadable database is a uid that is not listed.
  }
  const fields = passwd.split("\n").map((l) => l.split(":")).find((f) => f.length >= 4 && f[2] === String(uid));
  const raw = fields === undefined ? process.env.COTAL_SEAT_AGENT_GID : fields[3];
  const gid = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(gid) && gid >= 0 ? gid : undefined;
}

/** Whether the agent (uid, primary gid; libuv clears supplementary groups at spawn) can replace an
 *  entry of directory `st`. A sticky world-writable dir lets it replace only its own entries. */
export function agentCanReplace(st: Stats, uid: number, gid: number): boolean {
  if (st.uid === uid && (st.mode & 0o200) !== 0) return true;
  if (st.gid === gid && (st.mode & 0o020) !== 0) return true;
  return (st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0;
}

/** A caller-supplied seat cgroup must be this seat's cgroup under this process's own base, on
 *  cgroup2, before any write targets it. */
export function assertSeatCgroup(cg: SeatCgroup, id: string): SeatCgroup {
  const base = ownCgroup();
  // seatCgroupPath normalizes the base, so an exact match also rejects any non-normalized path.
  const path = cg.path;
  if (base === undefined || path !== seatCgroupPath(base, id)) throw new Error(`cgroup ${path} is not the cgroup of seat ${id} under this process's base ${String(base)}`);
  let fsType: number | undefined;
  try {
    fsType = statfsSync(path).type;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (fsType !== undefined && fsType !== CGROUP2_SUPER_MAGIC) throw new Error(`seat cgroup ${path} is not on cgroup2`);
  return cg;
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
  return ownCgroup() === cg.path;
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

function writableBy(st: Stats, uid: number, gid: number): boolean {
  if (st.mode & 0o002) return true;
  if (st.mode & 0o020 && st.gid === gid) return true;
  return st.uid === uid && (st.mode & 0o200) !== 0;
}

// Exit 10: a write landed, so the agent can migrate. Exit 11: every write was refused. Anything
// else (no setpriv, no CAP_SETUID, unknown user) is an attempt that never ran.
const MIGRATION_PROBE = 'for f; do if { echo $$ > "$f"; } 2>/dev/null; then exit 10; fi; done; exit 11';
// Fixed paths only: a root manager never resolves a program through an inherited PATH.
const SETPRIV_PATHS = ["/usr/bin/setpriv", "/bin/setpriv", "/run/current-system/sw/bin/setpriv"];

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
  const gid = agentPrimaryGid(uid);
  const setpriv = SETPRIV_PATHS.find((p) => existsSync(p));
  if (gid === undefined || setpriv === undefined) return false;
  const procs: string[] = [];
  for (let dir = dirname(cg.path); ; dir = dirname(dir)) {
    if (dir !== CGROUP_ROOT && !dir.startsWith(`${CGROUP_ROOT}/`)) return false;
    const file = join(dir, "cgroup.procs");
    try {
      if (writableBy(statSync(file), uid, gid)) return false;
    } catch {
      return false;
    }
    procs.push(file);
    if (dir === CGROUP_ROOT) break;
  }
  // The custodian runs with no supplementary groups, so the probe clears them too.
  const probe = spawnSync(setpriv, ["--reuid", String(uid), "--regid", String(gid), "--clear-groups", "--", "/bin/sh", "-c", MIGRATION_PROBE, "sh", ...procs], {
    stdio: "ignore",
    timeout: 5_000,
    env: {},
  });
  return probe.status === 11;
}
