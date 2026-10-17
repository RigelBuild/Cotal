import { lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { discardLaunchArtifacts, type AgentHandle, type AttachSession, type LaunchSpec, type RuntimeReference } from "@cotal-ai/core";
import type { ReleasableRuntime, RuntimeReapEvidence, RuntimeReleaseCheck } from "./index.js";
import { adoptSeatSync, agentCanReplace, agentPrimaryGid, CGROUP_DELEGATED_ENV, checkSeatRelease, launchSeat, loadSeat, reapSeat, removeSeatCustody, resolveCgroupBase, sealSeatLaunch, seatCgroupPath, seatId, unsupportedTransport, type SeatCgroup } from "@cotal-ai/seat";

/** Where custodial pty seats keep their records: `COTAL_SEAT_ROOT`, else `~/.cotal/seats`. */
export function custodyRoot(): string {
  return process.env.COTAL_SEAT_ROOT ?? join(homedir(), ".cotal", "seats");
}

export interface CustodialPtyRuntimeOpts {
  root?: string;
  /** Layer 3 base. Omitted resolves this process's own delegated cgroup at construction. */
  cgroupBase?: string;
  /** The uid seats run as. Omitted reads `COTAL_SEAT_AGENT_UID`, then this process's euid. */
  agentUid?: number;
}

function envAgentUid(): number | undefined {
  const raw = process.env.COTAL_SEAT_AGENT_UID?.trim();
  if (raw === undefined || raw === "") return undefined;
  const uid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(uid)) throw new Error(`COTAL_SEAT_AGENT_UID=${JSON.stringify(raw)} is not a uid`);
  return uid;
}

/**
 * Linux custodial pty: a one-shot launcher starts a detached per-seat
 * custodian, then this process holds only a proxy AgentHandle.
 * `createRuntime("pty")` no longer spawns through this class (#1391); it uses
 * it only to adopt and reap seats a pre-repair manager left running. Spawn and
 * adopt throw the named transport error off Linux.
 */
export class CustodialPtyRuntime implements ReleasableRuntime {
  readonly kind = "pty" as const;
  readonly supportsRelease = true;
  readonly root: string;
  /** Undefined: layer 3 is off on this host, so every reap of a live seat stays retained. */
  readonly cgroupBase: string | undefined;
  readonly agentUid: number;

  constructor(opts: CustodialPtyRuntimeOpts = {}) {
    this.root = opts.root ?? custodyRoot();
    const euid = process.geteuid?.() ?? -1;
    this.agentUid = opts.agentUid ?? envAgentUid() ?? euid;
    // Fail at construction, not at the first spawn: launchSeat would refuse every seat anyway.
    if (this.agentUid !== euid && euid !== 0) throw new Error(`seat agent uid ${this.agentUid} differs from this manager's uid ${euid}; a distinct agent uid needs a manager running with euid 0`);
    // An explicit base still needs the operator's delegation declaration, or layer 3 stays off.
    const declared = process.env[CGROUP_DELEGATED_ENV] === "1";
    this.cgroupBase = process.platform !== "linux" || !declared ? undefined : (opts.cgroupBase ?? resolveCgroupBase());
    if (process.platform === "linux" && this.cgroupBase === undefined)
      console.error(`custodial pty: no delegated cgroup v2 base (set ${CGROUP_DELEGATED_ENV}=1 in a Delegate=yes unit whose own cgroup this euid can write); seat cgroups are off and reaps of live seats stay retained`);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (this.agentUid !== euid) assertCustodyRoot(this.root, this.agentUid, euid);
  }

  /** Derived from the base and the id, never read from a record. */
  private cgroupOf(reference: RuntimeReference): { cgroup: SeatCgroup } | Record<string, never> {
    return this.cgroupBase === undefined ? {} : { cgroup: { path: seatCgroupPath(this.cgroupBase, reference.id), agentUid: this.agentUid } };
  }

  /** The seat directory's owner is the uid that launched it, and the agent cannot change it. A seat
   *  launched under another uid must not have its containment tested for this one. No directory:
   *  nothing launched one, or a launch died before its mkdir. */
  private launchedUnderOtherUid(reference: RuntimeReference): number | undefined {
    try {
      const owner = lstatSync(join(this.root, reference.id)).uid;
      return owner === this.agentUid ? undefined : owner;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Mint the custody id for a seat about to be launched. Nothing is written here: the id names a
   *  directory the custodian creates at launch, so a reserved id that is never spawned reaps as
   *  `absent`. The manager records this reference durably before it calls {@link spawn}. */
  reserve(): RuntimeReference {
    if (process.platform !== "linux") throw unsupportedTransport();
    return { kind: this.kind, id: seatId() };
  }

  spawn(name: string, spec: LaunchSpec, cwd: string, reference?: RuntimeReference): AgentHandle {
    try {
      if (process.platform !== "linux") throw unsupportedTransport();
      if (reference !== undefined && reference.kind !== "pty")
        throw new Error(`cannot spawn under runtime kind "${reference.kind}" with pty`);
    } catch (e) {
      // Refused before any process exists, so no child will read the launch's files (core
      // launch-artifacts). Every later refusal is launchSeat's, which removes them the same way.
      discardLaunchArtifacts(spec.artifacts);
      throw e;
    }
    const rec = launchSeat({
      root: this.root,
      name,
      spec: { command: spec.command, args: spec.args, env: spec.env ?? {}, confirm: spec.confirm, confirmBefore: spec.confirmBefore, artifacts: spec.artifacts },
      cwd,
      ...(reference ? { id: reference.id } : {}),
      ...(this.cgroupBase === undefined ? {} : { cgroupBase: this.cgroupBase }),
      agentUid: this.agentUid,
    });
    const seat = adoptSeatSync(rec);
    return { ...seat, release: () => seat.close() } as AgentHandle;
  }

  adopt(reference: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot adopt runtime kind "${reference.kind}" with pty`);
    const seat = adoptSeatSync(loadSeat(this.root, reference.id));
    return { ...seat, release: () => seat.close() } as AgentHandle;
  }

  async reap(reference: RuntimeReference): Promise<RuntimeReapEvidence> {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot reap runtime kind "${reference.kind}" with pty`);
    const other = this.launchedUnderOtherUid(reference);
    // Without its cgroup the reap cannot prove the seat gone, so it stays retained.
    if (other !== undefined) console.error(`custodial pty: seat ${reference.id} was launched under uid ${other}, not agent uid ${this.agentUid}; reaping it with no cgroup proof`);
    const evidence = await reapSeat(this.root, reference.id, other === undefined ? this.cgroupOf(reference) : {});
    // One to one: the seat's `stop` field describes the request it made and carries no proof.
    if (evidence.outcome === "absent") return { outcome: "absent" };
    if (evidence.outcome === "reaped") return { outcome: "reaped", detail: evidence.detail };
    return { outcome: "retained", reason: evidence.reason, detail: evidence.detail };
  }

  checkRelease(reference: RuntimeReference): RuntimeReleaseCheck {
    if (reference.kind !== "pty") throw new Error(`cannot release runtime kind "${reference.kind}" with pty`);
    return checkSeatRelease(this.root, reference.id, this.cgroupOf(reference));
  }

  sealRelease(reference: RuntimeReference): Promise<RuntimeReleaseCheck> {
    if (reference.kind !== "pty") throw new Error(`cannot release runtime kind "${reference.kind}" with pty`);
    return sealSeatLaunch(this.root, reference.id, this.cgroupOf(reference));
  }

  removeCustody(reference: RuntimeReference): void {
    if (reference.kind !== "pty") throw new Error(`cannot release runtime kind "${reference.kind}" with pty`);
    removeSeatCustody(this.root, reference.id);
  }
}

/** A distinct agent uid must traverse every ancestor of the custody root, or its custodian cannot open
 *  the launch fence; the default root under a root manager's home (`/root`) fails this. The root must be
 *  this euid's and no ancestor agent-replaceable, so a seat directory's owner is the uid that launched it. */
function assertCustodyRoot(root: string, agentUid: number, euid: number): void {
  const gid = agentPrimaryGid(agentUid);
  if (gid === undefined) throw new Error(`seat agent uid ${agentUid} is not in /etc/passwd and COTAL_SEAT_AGENT_GID names no gid`);
  const top = resolve(root);
  const st = lstatSync(top);
  if (!st.isDirectory() || st.uid !== euid) throw new Error(`custody root ${root} must be a directory owned by uid ${euid}, not ${st.uid}; refusing a root seat agent uid ${agentUid} could rearrange`);
  for (let dir = top; ; dir = dirname(dir)) {
    const d = statSync(dir);
    if (agentCanReplace(d, agentUid))
      throw new Error(`seat agent uid ${agentUid} can write ${dir}, at or above the custody root ${root}; set COTAL_SEAT_ROOT to a root it cannot rearrange`);
    // Spawned with no supplementary groups: only the owner, primary group and other bits apply.
    const bit = d.uid === agentUid ? 0o100 : d.gid === gid ? 0o010 : 0o001;
    if (dir !== top && (d.mode & bit) === 0)
      throw new Error(`seat agent uid ${agentUid} cannot traverse ${dir} above the custody root ${root}; set COTAL_SEAT_ROOT to a root it can reach`);
    if (dir === dirname(dir)) break;
  }
}

export type { AttachSession };
