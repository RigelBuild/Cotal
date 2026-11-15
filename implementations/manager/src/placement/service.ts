import { EpEnvelopeError } from "@cotal-ai/core";
import type {
  AcceptedIntent,
  EpCaller,
  EpServeContext,
  ExecutionGate,
  LaunchIntent,
  ManagedLifecycleTarget,
  Placement,
  ProfileSnapshot,
  SeatEntryV2,
} from "@cotal-ai/core";
import { MANAGER_CONTRACTS } from "../manager-service-contract.js";

export interface RetirementObligation {
  obligationId: string;
  name: string;
  generation: number;
  reason: "pause" | "remove" | "replace";
  committedRevision: number;
  state: "pending" | "unknown" | "terminal";
  deathProofId?: string;
  keyDenialProofId?: string;
}

export interface KeyObservation {
  desiredAuthorizationRevision: number;
  appliedAuthorizationRevision?: number;
  settingsRevision?: number;
  operationId?: string;
  condition: "effective" | "pending" | "unknown" | "rejected";
  observedAt: string;
}

/** The strict JSON result of manager.observe and manager.stop-placement. */
export interface SeatObservation {
  placement: Placement;
  lifecycle?: ManagedLifecycleTarget;
  state: "pending" | "starting" | "running" | "stopping" | "stopped" | "unknown" | "parked";
  executionIdentity?: string;
  keyId?: string;
  reason?: string;
  key?: KeyObservation;
  obligations: RetirementObligation[];
}

/** Trusted manager-side placement operations. Caller identity comes from the authenticated EP subject. */
export interface PlacementAuthorityCallbacks {
  prepareLaunch(args: { placement: Placement; entry: SeatEntryV2; caller: EpCaller }): Promise<LaunchIntent>;
  place(args: { accepted: AcceptedIntent; caller: EpCaller }): Promise<{ observation: SeatObservation; executionGate: ExecutionGate }>;
  observe(args: { name: string; generation: number; caller: EpCaller }): Promise<SeatObservation>;
  stopPlacement(args: { placement: Placement; caller: EpCaller }): Promise<SeatObservation>;
}

export interface PlacementServiceDeps {
  authorizePlacement?: (context: EpServeContext) => boolean | Promise<boolean>;
  profileGet?: (name: string) => Promise<ProfileSnapshot>;
  placementAuthority?: PlacementAuthorityCallbacks;
}

function requestArgs<T>(ctx: EpServeContext, command: string): T {
  const value: unknown = ctx.request.args;
  if (!MANAGER_CONTRACTS[command]?.input.validate(value))
    throw new EpEnvelopeError("bad-request", `invalid ${command} request`, undefined, "not-executed");
  // SAFETY: the compiled input contract above validates every field of this request.
  return value as T;
}

async function authorize(ctx: EpServeContext, deps: PlacementServiceDeps): Promise<void> {
  let authorized = false;
  try {
    authorized = deps.authorizePlacement ? await deps.authorizePlacement(ctx) : false;
  } catch {
    authorized = false;
  }
  if (!authorized)
    throw new EpEnvelopeError("permission-denied", "placement requires the authenticated reconciler service principal", undefined, "not-executed");
}

function unsupported(seam: string): never {
  throw new EpEnvelopeError("unimplemented", `unsupported: ${seam} is not available`, undefined, "not-executed");
}

/** Closed manager endpoint handlers for the frozen T1 placement protocol. */
export function placementServiceHandlers(deps: PlacementServiceDeps): {
  place(ctx: EpServeContext): Promise<unknown>;
  observe(ctx: EpServeContext): Promise<unknown>;
  stopPlacement(ctx: EpServeContext): Promise<unknown>;
  prepareLaunch(ctx: EpServeContext): Promise<unknown>;
  profileGet(ctx: EpServeContext): Promise<unknown>;
} {
  const callPlacement = async <T>(ctx: EpServeContext, seam: string, action: (callbacks: PlacementAuthorityCallbacks) => Promise<T>): Promise<T> => {
    await authorize(ctx, deps);
    if (!deps.placementAuthority) return unsupported(seam);
    return action(deps.placementAuthority);
  };

  return {
    place: (ctx) => callPlacement(ctx, "T5 RuntimeProvider create/rebind, private-stage and bootstrap", (callbacks) => callbacks.place({
      accepted: requestArgs<{ accepted: AcceptedIntent }>(ctx, "place").accepted,
      caller: ctx.subject.caller,
    })),
    observe: (ctx) => callPlacement(ctx, "retained placement/execution journal and T5 RuntimeProvider.rebindDelegated", async (callbacks) => {
      const args = requestArgs<{ name: string; generation: number }>(ctx, "observe");
      const observation = await callbacks.observe({ name: args.name, generation: args.generation, caller: ctx.subject.caller });
      if (observation.placement.name !== args.name || observation.placement.generation !== args.generation)
        throw new EpEnvelopeError("expired", `retained observation for ${args.name} generation ${args.generation} is unavailable`, undefined, "not-executed");
      return observation;
    }),
    stopPlacement: (ctx) => callPlacement(ctx, "T5 RuntimeProvider.close and terminal retirement proof", (callbacks) => callbacks.stopPlacement({
      placement: requestArgs<{ placement: Placement }>(ctx, "stop-placement").placement,
      caller: ctx.subject.caller,
    })),
    prepareLaunch: (ctx) => callPlacement(ctx, "trusted workspace, immutable profile, RuntimeAssets and persona preparation", (callbacks) => {
      const args = requestArgs<{ placement: Placement; entry: SeatEntryV2 }>(ctx, "prepare-launch");
      return callbacks.prepareLaunch({
        placement: args.placement,
        entry: args.entry,
        caller: ctx.subject.caller,
      });
    }),
    profileGet: async (ctx) => {
      await authorize(ctx, deps);
      const { name } = requestArgs<{ name: string }>(ctx, "profile-get");
      if (!deps.profileGet) return unsupported("trusted Orion immutable profile catalog");
      return deps.profileGet(name);
    },
  };
}
