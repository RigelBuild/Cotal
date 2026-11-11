import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
  registry,
  SpawnRefused,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type RuntimeReference,
} from "@cotal-ai/core";
import { privateLauncher } from "./runtime.js";

const STOP_GRACE_MS = 30_000;
const POLL_MS = 1_000;
const START_TIMEOUT_MS = 15_000;

export type HolderReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: "unprovable" | "members-remain"; detail: string };
type ProcessState = "alive" | "gone" | "unknown";
type ProcessIdentity = { readonly pid: number; readonly startTime: string };
type ProcessRecord = ProcessIdentity & { readonly state: string };
type ExecOptions = { readonly cwd?: string; readonly encoding: "utf8"; readonly timeout?: number };
type HolderExec = (file: string, args: string[], options: ExecOptions) => string;
type ProcFs = { readFileSync(path: string, encoding: "utf8"): string };
type HolderRuntimeOptions = {
  readonly holderCommand?: () => string | undefined;
  readonly unitPrefix?: () => string;
  readonly execFileSync?: HolderExec;
  readonly fs?: ProcFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** "darwin" selects wave-host identity and stop; any other value keeps /proc and systemctl. */
  readonly platform?: NodeJS.Platform;
  /** The Darwin wave-host executable. Required on darwin; the seat cannot start without it. */
  readonly waveHostCommand?: () => string | undefined;
};

const defaultExec: HolderExec = (file, args, options) => execFileSync(file, args, options);
const defaultFs: ProcFs = { readFileSync: (path, encoding) => readFileSync(path, encoding) };
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultKill = (pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); };

function parseProcessStat(raw: string, expectedPid: number): ProcessRecord | undefined {
  const closingParen = raw.lastIndexOf(")");
  const prefix = closingParen < 0 ? undefined : /^(\d+) \(/.exec(raw);
  if (prefix?.[1] !== String(expectedPid) || closingParen < 0) return undefined;
  const fields = raw.slice(closingParen + 1).trim().split(/\s+/u);
  const state = fields[0];
  const startTime = fields[19];
  if (state === undefined || startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;
  return { pid: expectedPid, state, startTime };
}

function isMissingProcess(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ESRCH";
}

function exitStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function parseStartOutput(stdout: string): { holderPid: number; agentPid: number } {
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(stdout);
  const holderPid = match?.[1] === undefined ? undefined : Number(match[1]);
  const agentPid = match?.[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(holderPid) || holderPid === undefined || holderPid <= 0 ||
      !Number.isSafeInteger(agentPid) || agentPid === undefined || agentPid <= 0)
    throw new Error(`holder runtime: invalid start output ${JSON.stringify(stdout)}`);
  return { holderPid, agentPid };
}

function parseReference(reference: RuntimeReference): { name: string; holder: ProcessIdentity; agent: ProcessIdentity } | undefined {
  if (reference.kind !== "holder") return undefined;
  const match = /^([A-Za-z0-9_.-]+):([1-9]\d*):(\d+):([1-9]\d*):(\d+)$/u.exec(reference.id);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return undefined;
  const holderPid = Number(match[2]);
  const agentPid = Number(match[4]);
  if (!Number.isSafeInteger(holderPid) || !Number.isSafeInteger(agentPid)) return undefined;
  return {
    name: match[1],
    holder: { pid: holderPid, startTime: match[3] },
    agent: { pid: agentPid, startTime: match[5] },
  };
}

export class HolderRuntime implements Runtime {
  readonly kind = "holder" as const;
  readonly streamsTerminal = false;
  private readonly command: () => string | undefined;
  private readonly prefix: () => string;
  private readonly exec: HolderExec;
  private readonly fs: ProcFs;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly platform: NodeJS.Platform;
  private readonly waveHost: () => string | undefined;

  constructor(options: HolderRuntimeOptions = {}) {
    this.command = options.holderCommand ?? (() => process.env.COTAL_HOLDER_COMMAND);
    this.prefix = options.unitPrefix ?? (() => process.env.WAVE_SEAT_UNIT_PREFIX ?? "wave-seat-");
    this.exec = options.execFileSync ?? defaultExec;
    this.fs = options.fs ?? defaultFs;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.waveHost = options.waveHostCommand ?? (() => process.env.WAVE_HOST_COMMAND);
    this.kill = options.kill ?? defaultKill;
  }

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (spec.confirm !== undefined)
      throw new SpawnRefused("holder runtime: startup confirmation is not supported");
    const holder = this.command();
    if (holder === undefined)
      throw new SpawnRefused("holder runtime: COTAL_HOLDER_COMMAND is not set");

    const launcher = privateLauncher(spec, cwd, name);
    let launcherCleaned = false;
    const cleanupLauncher = (): void => {
      if (launcherCleaned) return;
      launcherCleaned = true;
      rmSync(launcher.dir, { recursive: true, force: true });
    };
    let holderAcceptedStart = false;
    try {
      let stdout: string;
      try {
        stdout = this.exec(holder, ["start", "--name", name, "--", ...launcher.argv], {
          cwd: launcher.cwd,
          encoding: "utf8",
          timeout: START_TIMEOUT_MS,
        });
        holderAcceptedStart = true;
      } catch (error) {
        if (exitStatus(error) === 4)
          throw new SpawnRefused(`seat ${name} is already live; stop it with: systemctl --user stop ${this.prefix()}${name}`);
        throw error;
      }

      const { holderPid, agentPid } = parseStartOutput(stdout);
      const holderRecord = this.readProcess(holderPid);
      const agentRecord = this.readProcess(agentPid);
      if (holderRecord === undefined || agentRecord === undefined ||
          holderRecord.state === "Z" || holderRecord.state === "X" ||
          agentRecord.state === "Z" || agentRecord.state === "X")
        throw new Error(`holder runtime: could not read live process identities for seat ${name}`);

      const reference: RuntimeReference = {
        kind: "holder",
        id: `${name}:${holderPid}:${holderRecord.startTime}:${agentPid}:${agentRecord.startTime}`,
      };
      const identities = {
        holder: { pid: holderPid, startTime: holderRecord.startTime },
        agent: { pid: agentPid, startTime: agentRecord.startTime },
      };
      const status = (): "running" | "exited" => {
        const state = this.status(identities);
        if (state === "exited") cleanupLauncher();
        return state;
      };
      cleanupLauncher();
      return {
        name,
        kind: "holder",
        reference,
        pid: agentPid,
        status,
        stop: (opts) => {
          if (this.areGone(identities)) return;
          try {
            if (opts?.graceful === false) this.forceStop(name, identities);
            else this.stopUnit(name, identities);
          } catch (error) {
            if (!this.areGone(identities)) throw error;
          }
        },
        interrupt: () => this.exec(holder, ["interrupt", "--name", name], { encoding: "utf8", timeout: START_TIMEOUT_MS }),
        waitForExit: async () => {
          while (status() !== "exited") await this.sleep(POLL_MS);
        },
        attach: () => {
          throw new Error("holder runtime: attach with wave-seat-holder attach");
        },
      };
    } catch (error) {
      if (holderAcceptedStart) {
        try { this.stopSeatJob(name); } catch { /* the original start failure is primary */ }
        try { cleanupLauncher(); } catch { /* best effort after stopping the unit */ }
      }
      throw error;
    } finally {
      if (!holderAcceptedStart) cleanupLauncher();
    }
  }

  async reap(reference: RuntimeReference): Promise<HolderReapEvidence> {
    const parsed = parseReference(reference);
    if (parsed === undefined) return { outcome: "absent" };
    const identities = { holder: parsed.holder, agent: parsed.agent };
    if (this.areGone(identities)) return { outcome: "reaped", detail: `both process identities for seat ${parsed.name} are gone` };

    try {
      this.stopUnit(parsed.name, identities);
    } catch {
      // Still wait and force below; a failed graceful request is not proof of death.
    }
    const deadline = this.now() + STOP_GRACE_MS;
    while (!this.areGone(identities) && this.now() < deadline)
      await this.sleep(Math.min(POLL_MS, deadline - this.now()));

    if (!this.areGone(identities)) {
      try {
        this.forceStop(parsed.name, identities);
      } catch {
        // The final process-identity check below decides whether the seat is gone or retained.
      }
    }
    const holderState = this.processState(identities.holder);
    const agentState = this.processState(identities.agent);
    if (holderState === "gone" && agentState === "gone")
      return { outcome: "reaped", detail: `seat ${parsed.name} process identities are gone after stop` };
    const detail = `wave-seat-${parsed.name} still has a live or unreadable process identity after forced stop`;
    return {
      outcome: "retained",
      reason: holderState === "unknown" || agentState === "unknown" ? "unprovable" : "members-remain",
      detail,
    };
  }

  private readProcess(pid: number): ProcessRecord | undefined {
    if (this.platform === "darwin") {
      const token = this.darwinStartToken(pid);
      return token === undefined ? undefined : { pid, state: "S", startTime: token };
    }
    try {
      return parseProcessStat(this.fs.readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
    } catch {
      return undefined;
    }
  }

  /** The start token wave-host reports for a live pid; undefined when absent or unreadable. */
  private darwinStartToken(pid: number): string | undefined {
    try {
      const out = this.exec(this.requireWaveHost(), ["process-identity", "--pid", String(pid)], { encoding: "utf8", timeout: START_TIMEOUT_MS });
      return /^\d+\s*$/u.test(out) ? out.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private requireWaveHost(): string {
    const command = this.waveHost();
    if (command === undefined) throw new SpawnRefused("holder runtime: WAVE_HOST_COMMAND is not set");
    return command;
  }

  private processState(identity: ProcessIdentity): ProcessState {
    if (this.platform === "darwin") {
      let token: string;
      try {
        token = this.exec(this.requireWaveHost(), ["process-identity", "--pid", String(identity.pid)], { encoding: "utf8", timeout: START_TIMEOUT_MS }).trim();
      } catch (error) {
        return exitStatus(error) === 3 ? "gone" : "unknown";
      }
      if (!/^\d+$/u.test(token)) return "unknown";
      return token === identity.startTime ? "alive" : "gone";
    }
    let raw: string;
    try {
      raw = this.fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    } catch (error) {
      return isMissingProcess(error) ? "gone" : "unknown";
    }
    const current = parseProcessStat(raw, identity.pid);
    if (current === undefined) return "unknown";
    if (current.startTime !== identity.startTime || current.state === "Z" || current.state === "X") return "gone";
    return "alive";
  }

  private status(identities: { holder: ProcessIdentity; agent: ProcessIdentity }): "running" | "exited" {
    return this.areGone(identities) ? "exited" : "running";
  }

  private areGone(identities: { holder: ProcessIdentity; agent: ProcessIdentity }): boolean {
    return this.processState(identities.holder) === "gone" && this.processState(identities.agent) === "gone";
  }

  private stopUnit(name: string, identities: { holder: ProcessIdentity; agent: ProcessIdentity }): void {
    if (this.areGone(identities)) return;
    try {
      this.stopSeatJob(name);
    } catch (error) {
      if (!this.areGone(identities)) throw error;
    }
  }

  /** The graceful, platform-correct stop of a seat's job. Darwin removes its launchd job; Linux stops the unit. */
  private stopSeatJob(name: string): void {
    if (this.platform === "darwin") {
      this.exec(this.requireWaveHost(), ["seat-stop", "--name", name], { encoding: "utf8", timeout: START_TIMEOUT_MS });
      return;
    }
    this.exec("systemctl", ["--user", "stop", "--no-block", `${this.prefix()}${name}`], { encoding: "utf8" });
  }

  private forceStop(name: string, identities: { holder: ProcessIdentity; agent: ProcessIdentity }): void {
    if (this.areGone(identities)) return;
    try {
      if (this.processState(identities.agent) === "alive") this.kill(identities.agent.pid, "SIGKILL");
    } catch (error) {
      if (!isMissingProcess(error) && !this.areGone(identities)) throw error;
    }
    try {
      if (this.platform === "darwin") this.stopSeatJob(name);
      else this.exec("systemctl", ["--user", "kill", "-s", "SIGKILL", `${this.prefix()}${name}`], { encoding: "utf8" });
    } catch (error) {
      if (!this.areGone(identities)) throw error;
    }
  }
}

export const holderRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "holder",
  available: () => process.env.COTAL_HOLDER_COMMAND !== undefined,
  create: () => new HolderRuntime(),
};

registry.register(holderRuntimeProvider);
