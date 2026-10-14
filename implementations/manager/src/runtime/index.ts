import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type AgentHandle, type Runtime, type RuntimeKind, type RuntimeProvider, type RuntimeReference } from "@cotal-ai/core";
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
  reap(reference: RuntimeReference): Promise<RuntimeReapEvidence>;
}

/** Whether this backend custodies its own processes. Both methods are required together: a runtime
 *  that could mint references but never prove them gone would have the manager record references no
 *  successor can act on, which is worse than recording none. */
export function isCustodialRuntime(runtime: Runtime): runtime is CustodialRuntime {
  const r = runtime as Partial<CustodialRuntime>;
  return typeof r.reserve === "function" && typeof r.reap === "function";
}

/** Reap an orphaned custody by reference, or refuse by name when this runtime does not custody its
 *  own processes. Absent and retained mean REFUSE, never "assume gone": the lifecycle stays held
 *  rather than retiring over a live seat. */
export async function requireRuntimeReap(
  runtime: Runtime,
  reference: RuntimeReference,
): Promise<{ outcome: "reaped"; detail: string }> {
  if (!isCustodialRuntime(runtime))
    throw new Error(`runtime "${runtime.kind}" does not support reap; the orphaned process for ${reference.kind}:${reference.id} cannot be proved gone`);
  const evidence = await runtime.reap(reference);
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
