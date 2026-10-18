import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  discardLaunchArtifacts,
  reclaimWithChild,
  registry,
  SpawnRefused,
  type AgentHandle,
  type AttachSession,
  type Runtime,
  type RuntimeKind,
  type RuntimeProvider,
  type RuntimeReference,
} from "@cotal-ai/core";
import { CustodialPtyRuntime } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** Adopt a durable handle, or refuse by name when this runtime has no adopt method. */
export function requireRuntimeAdopt(runtime: Runtime, reference: RuntimeReference): AgentHandle {
  if (typeof runtime.adopt !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support adopt`);
  return runtime.adopt(reference);
}

/** What a {@link CustodialRuntime.reap} proved. `absent`: the custody record for that reference
 *  could not be read. That is a statement about ADDRESSABILITY, not about liveness, and the two are
 *  not the same fact: a custodian that dies after spawning its child and before writing the record
 *  leaves a LIVE seat and no record, and a stale or wrong reference looks for a record that exists
 *  at a different path. `retained`: the record was read, but nothing on this host could prove the
 *  seat's processes gone (`unprovable`), or a contained group still held members at the bound
 *  (`members-remain`). `reaped`: the seat's processes were proved gone. Only `reaped` proves
 *  anything about a process. */
export type RuntimeReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: "unprovable" | "members-remain"; detail: string };

/** Why a reap did not prove a seat gone. `no-reference`: no custody reference reached the reap at
 *  all, so there was nothing to address. The other three are the runtime's own outcomes. */
export type RuntimeUnprovenReason = "absent" | "no-reference" | "unprovable" | "members-remain";

/** A reap that could not PROVE the seat gone, thrown by {@link requireRuntimeReap} on an `absent` or
 *  `retained` outcome so no caller can render it as a disposal it did not make. Carries the
 *  reference (when one existed) and the reason, so the operator has what to search for and why. */
export class RuntimeReapUnproven extends Error {
  readonly reference: RuntimeReference | undefined;
  readonly reason: RuntimeUnprovenReason;
  constructor(runtimeKind: string, reference: RuntimeReference | undefined, reason: RuntimeUnprovenReason, detail?: string) {
    const ref = reference === undefined ? "no custody reference" : `${reference.kind}:${reference.id}`;
    const why =
      reason === "absent"
        ? `runtime "${runtimeKind}" holds no custody record for ${ref}, so the seat it addresses is NOT proved gone; ` +
          `a custodian that died before writing its record leaves a live seat behind this same outcome`
        : reason === "no-reference"
          ? `runtime "${runtimeKind}" custodies its seats, but no custody reference reached this reap, so any seat it launched is NOT proved gone`
          : `runtime "${runtimeKind}" retained ${ref} (${reason}), so the seat it addresses is NOT proved gone`;
    super(detail === undefined ? why : `${why}: ${detail}`);
    this.name = "RuntimeReapUnproven";
    this.reference = reference;
    this.reason = reason;
  }
}

/**
 * A runtime that OWNS the processes it starts, durably enough to address them after the manager
 * that started them is gone.
 *
 * This is deliberately NOT on the core {@link Runtime} contract. Core hosts the extension contracts
 * so that any backend can implement them, and these two cannot be implemented by a backend that
 * delegates to an external surface: `tmux`, `cmux`, `orca` and `herdr` do not own a process to
 * signal or a custody record to pre-mint against, so the methods would have no meaning for them
 * rather than merely no implementation. `adopt` stays on the generic contract because "reattach to
 * a handle you created" is something a delegating backend could one day mean.
 *
 * `reserve` mints the custody reference BEFORE any process exists, so the caller can record it
 * durably and hand the same reference to `spawn`; the reference then precedes the processes it
 * addresses. `reap` signals only a process whose identity it verifies against its own record,
 * proves it and its descendants gone, and forgets the record.
 */
export interface CustodialRuntime extends Runtime {
  reserve(): RuntimeReference;
  /** Also removes the launch artifacts (core launch-artifacts) the custody record still lists, once
   *  the seat is proved gone, even when another manager launched it. */
  reap(reference: RuntimeReference): Promise<RuntimeReapEvidence>;
}

/** Whether this backend custodies its own processes. Both methods are required together: a runtime
 *  that could mint references but never prove them gone would have the manager record references no
 *  successor can act on, which is worse than recording none. */
export function isCustodialRuntime(runtime: Runtime): runtime is CustodialRuntime {
  const r = runtime as Partial<CustodialRuntime>;
  return typeof r.reserve === "function" && typeof r.reap === "function";
}

/** What a release check found. `advisory` is census text, never proof. */
export type RuntimeReleaseCheck = { ok: true; advisory: string } | { ok: false; reason: "populated" | "launch-in-progress"; detail: string };

/** A custodial backend an operator can release a retained seat from: check, seal its launch, then
 *  remove its custody. None of these sends a signal. */
export interface ReleasableRuntime extends CustodialRuntime {
  checkRelease(reference: RuntimeReference): RuntimeReleaseCheck;
  sealRelease(reference: RuntimeReference): Promise<RuntimeReleaseCheck>;
  removeCustody(reference: RuntimeReference): void;
}

export function isReleasableRuntime(runtime: Runtime): runtime is ReleasableRuntime {
  const r = runtime as Partial<ReleasableRuntime>;
  return isCustodialRuntime(runtime) && typeof r.checkRelease === "function" && typeof r.sealRelease === "function" && typeof r.removeCustody === "function";
}

/** Reap an orphaned custody by reference, or refuse by name when this runtime does not custody its
 *  own processes. Absent and retained mean REFUSE, never "assume gone": the lifecycle stays held
 *  rather than retiring over a live seat. */
export async function requireRuntimeReap(
  runtime: Runtime,
  reference: RuntimeReference,
): Promise<{ outcome: "reaped"; detail: string }> {
  if (typeof (runtime as Partial<CustodialRuntime>).reap !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support reap; the orphaned process for ${reference.kind}:${reference.id} cannot be proved gone`);
  const evidence = await (runtime as CustodialRuntime).reap(reference);
  // The refusal this function's contract promises, made structural: only `reaped` leaves here, so
  // the return type carries no branch a caller could render as success.
  if (evidence.outcome === "absent") throw new RuntimeReapUnproven(runtime.kind, reference, "absent");
  if (evidence.outcome === "retained") throw new RuntimeReapUnproven(runtime.kind, reference, evidence.reason, evidence.detail);
  return evidence;
}

/** How a manager picks its backend. `auto` is the deterministic default — always `pty`. External
 *  runtimes are never auto-selected; choose one explicitly, which resolves
 *  the integration from the registry and fails loud if it isn't imported. No fallbacks. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `pty` ships with the manager and is what `auto`
 *  resolves to. Every other name resolves a self-registered {@link RuntimeProvider}; an explicit
 *  provider that is absent or unreachable throws, never a silent fallback to pty. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  return ownLaunchArtifacts(createBackend(mode, session));
}

function createBackend(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind = mode === "auto" ? "pty" : mode;
  if (kind === "pty") {
    // node-pty's native spawn-helper hangs before exec under Bun — it never becomes the child, so
    // every agent wedges at "starting…" with no error. Fail loud rather than silently break the mesh:
    // the pty runtime is Node-only. External runtimes drive their own CLIs (no node-pty), so they're fine.
    if (process.versions.bun)
      throw new Error(
        `the pty runtime requires Node.js - the manager is running under Bun (v${process.versions.bun}), ` +
          `where @lydell/node-pty's spawn-helper hangs before exec and every agent wedges at "starting…". ` +
          `Run the manager under node, or install and select an external runtime.`,
      );
    // The fork's custody contract: every Linux seat runs under a custodian.
    if (process.platform === "linux") return new CustodialPtyRuntime();
    return new LegacyPtyRuntime();
  }
  let provider: RuntimeProvider;
  try {
    provider = registry.resolve<RuntimeProvider>("runtime", kind);
  } catch {
    throw new Error(
      `unknown runtime "${kind}" - install its integration with \`cotal ext add <npm-package>\`, or import it in this composition root`,
    );
  }
  if (!provider.available())
    throw new Error(`${kind} runtime requested but it is not reachable`);
  return provider.create({ session });
}

/**
 * The launcher's half of core launch-artifacts, installed on every runtime this module creates so it
 * holds for every backend: a spec's private files are removed only once the runtime has proved its
 * child gone.
 *
 * - A custodial runtime (one with `reserve` and `reap`; the built-in pty is not one) hands the files
 *   to the seat's custodian, the parent of the child: it removes them when it sees that child exit,
 *   so they go on exit, stop and the custodian's own unattended timeout whether or not any manager
 *   is still alive. The runtime removes them on a refusal made before any process existed. The end
 *   of this manager's attach stream proves nothing, since a custodian that dies leaves its child
 *   running, so nothing here listens to it. Its reap, once it proves the seat gone, removes what the
 *   custody record still lists, which covers a custodian killed before its child exited and a
 *   removal that failed.
 * - Any other runtime, the built-in pty included, gets the spec through core `reclaimWithChild`, so
 *   a watcher beside the child removes the files once the child is gone even when this manager was
 *   killed. This manager also discards on the exit its attach session streams (the in-process pty).
 *   One that cannot attach (tmux, cmux, orca, herdr) is polled through `status()`, and its
 *   `waitForExit`, the proof every stop already awaits, confirms the exit before the files go.
 * - A spawn that throws {@link SpawnRefused} failed before it handed the spec's command to anything
 *   that could start it, so its files go at once. Any other throw is not proof that nothing
 *   started (a backend can fail after its child is up), so its files stay for the child's watcher,
 *   or for the OS temp reaper when no child started.
 * - A removal that fails is tried again every few seconds until it succeeds.
 */
function ownLaunchArtifacts(runtime: Runtime): Runtime {
  if (isCustodialRuntime(runtime)) return runtime;
  const spawn = runtime.spawn.bind(runtime);
  runtime.spawn = (name, spec, cwd, reference) => {
    let handle: AgentHandle;
    try {
      handle = spawn(name, reclaimWithChild(spec), cwd, reference);
    } catch (e) {
      if (e instanceof SpawnRefused) removeOwned(name, spec.artifacts);
      throw e;
    }
    if (spec.artifacts?.length) discardOnExit(name, handle, spec.artifacts);
    return handle;
  };
  return runtime;
}

/** How often a handle with no exit stream is asked whether its child has exited, and how often a
 *  failed removal is tried again. */
const EXIT_POLL_MS = 5_000;

/** Remove artifacts whose child is proved gone or never started. Ownership ends when the removal
 *  succeeds, not when it is tried: a failure keeps a timer retrying it. */
function removeOwned(name: string, artifacts: readonly string[] | undefined): void {
  if (!artifacts?.length) return;
  let retry: ReturnType<typeof setInterval> | undefined;
  const attempt = () => {
    try {
      discardLaunchArtifacts(artifacts);
    } catch (e) {
      if (!retry) {
        console.error(`! ${name}: ${(e as Error).message}; trying again every ${EXIT_POLL_MS / 1000}s`);
        retry = setInterval(attempt, EXIT_POLL_MS);
        retry.unref();
      }
      return;
    }
    clearInterval(retry);
  };
  attempt();
}

function discardOnExit(name: string, handle: AgentHandle, artifacts: readonly string[]): void {
  let done = false;
  // Runs only once the exit is proved.
  const finish = () => {
    if (done) return;
    done = true;
    removeOwned(name, artifacts);
  };
  // Wrapped, never called at spawn: a runtime bounds its wait for a stop (tmux gives up after
  // seconds), so a wait started at spawn would give up on every seat that outlives that bound.
  const wait = handle.waitForExit?.bind(handle);
  if (wait) handle.waitForExit = () => wait().then(finish);
  watchProvedExit(handle, finish, () => !done);
}

/** Call `onExit` once the runtime proves `handle`'s child gone, until `watching` turns false. A
 *  handle with no exit stream is polled through `status()` and its `waitForExit` confirms the exit,
 *  so a seat that ends on its own is seen as well as one that is stopped. Returns false when the
 *  handle can do neither, so no exit of its child will ever be seen. */
export function watchProvedExit(handle: AgentHandle, onExit: () => void, watching: () => boolean): boolean {
  let session: AttachSession;
  try {
    session = handle.attach();
  } catch {
    return pollProvedExit(handle, onExit, watching, EXIT_POLL_MS);
  }
  session.onExit(onExit);
  // A child that exited before the subscription fires no event for it.
  if (handle.status() === "exited") onExit();
  return true;
}

/** Call `onExit` once `handle`'s `status()`, read every `pollMs`, says its child exited and its
 *  `waitForExit` confirms it, until `watching` turns false. Returns false when the handle has no
 *  `waitForExit`, so no exit of its child can be proved. */
export function pollProvedExit(handle: AgentHandle, onExit: () => void, watching: () => boolean, pollMs: number): boolean {
  if (!handle.waitForExit) return false;
  let waiting = false;
  const poll = setInterval(() => {
    if (!watching()) {
      clearInterval(poll);
      return;
    }
    if (waiting) return;
    const proof = exitProof(handle);
    if (!proof) return;
    waiting = true;
    proof.then(
      () => {
        clearInterval(poll);
        onExit();
      },
      () => {
        waiting = false;
      },
    );
  }, pollMs);
  poll.unref();
  return true;
}

/** `handle`'s `waitForExit` once its `status()` says its child exited, or undefined while the child
 *  runs, while `status()` throws, or when the handle has no `waitForExit`. */
export function exitProof(handle: AgentHandle): Promise<void> | undefined {
  const wait = handle.waitForExit?.bind(handle);
  if (!wait) return undefined;
  let exited: boolean;
  try {
    exited = handle.status() === "exited";
  } catch {
    return undefined;
  }
  // Called from a continuation so a wait that throws becomes a rejection.
  return exited ? Promise.resolve().then(wait) : undefined;
}

/** Walk up from `startDir` to the pnpm workspace root (for spawning `pnpm cotal …`). */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
