import { lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentHandle, AttachSession, LaunchSpec, RuntimeReference } from "@cotal-ai/core";
import type { ReleasableRuntime, RuntimeReapEvidence, RuntimeReleaseCheck } from "./index.js";
import { adoptSeatSync, checkSeatRelease, idList, launchSeat, loadSeat, reapSeat, removeSeatCustody, resolveCgroupBase, sealSeatLaunch, seatCgroupPath, seatId, unsupportedTransport, type SeatCgroup } from "@cotal-ai/seat";

function defaultCustodyRoot(): string {
  return join(homedir(), ".cotal", "seats");
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
 * Production pty runtime on Linux: a one-shot launcher starts a detached
 * per-seat custodian, then this process holds only a proxy AgentHandle.
 * `createRuntime("pty")` does not construct this class off Linux. Spawn and
 * adopt still throw the named transport error if it is instantiated there.
 */
export class CustodialPtyRuntime implements ReleasableRuntime {
  readonly kind = "pty" as const;
  readonly supportsRelease = true;
  readonly root: string;
  /** Undefined: layer 3 is off on this host, so every reap of a live seat stays retained. */
  readonly cgroupBase: string | undefined;
  readonly agentUid: number;

  constructor(opts: CustodialPtyRuntimeOpts = {}) {
    this.root = opts.root ?? process.env.COTAL_SEAT_ROOT ?? defaultCustodyRoot();
    const euid = process.geteuid?.() ?? -1;
    this.agentUid = opts.agentUid ?? envAgentUid() ?? euid;
    // Fail at construction, not at the first spawn: launchSeat would refuse every seat anyway.
    if (this.agentUid !== euid && euid !== 0) throw new Error(`seat agent uid ${this.agentUid} differs from this manager's uid ${euid}; a distinct agent uid needs a manager running with euid 0`);
    this.cgroupBase = opts.cgroupBase ?? (process.platform === "linux" ? resolveCgroupBase() : undefined);
    if (process.platform === "linux" && this.cgroupBase === undefined)
      console.error("custodial pty: no writable cgroup v2 base for this process (run under Delegate=yes); seat cgroups are off and reaps of live seats stay retained");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (this.agentUid !== euid) assertAgentTraverses(this.root, this.agentUid);
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
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference !== undefined && reference.kind !== "pty")
      throw new Error(`cannot spawn under runtime kind "${reference.kind}" with pty`);
    const rec = launchSeat({
      root: this.root,
      name,
      spec: { command: spec.command, args: spec.args, env: spec.env ?? {}, confirm: spec.confirm },
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

/** A distinct agent uid must traverse every ancestor of the custody root, or its custodian cannot
 *  open the launch fence. The default root under a root manager's home (`/root`) fails this. */
function assertAgentTraverses(root: string, agentUid: number): void {
  const groups = idList("-G", agentUid) ?? [];
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    const st = statSync(dir);
    const bit = st.uid === agentUid ? 0o100 : groups.includes(st.gid) ? 0o010 : 0o001;
    if ((st.mode & bit) === 0)
      throw new Error(`seat agent uid ${agentUid} cannot traverse ${dir} above the custody root ${root}; set COTAL_SEAT_ROOT to a root it can reach`);
    if (dir === dirname(dir)) break;
  }
}

export type { AttachSession };
