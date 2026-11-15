/**
 * The placement participant door: the four endpoint handlers that bind the placement
 * participant operations to the auth endpoint.
 *
 * The transport principal is the broker-authenticated caller on the subject, never a body field.
 * It is mapped by the injected `ServiceAuthenticator` inside the port, which admits only the
 * configured reconciler. This door only forwards the subject principal and the validated args.
 */
import { EpEnvelopeError, principalKey, type EpServeContext } from "@cotal-ai/core";
import type { EnrollmentIdentity, PlacementEffectStatusResult, PlacementEnrollmentAuthority, PlacementRetireResult, VerifyPlacementResult } from "./placement-enrollment.js";

/** The four placement handler signatures. Each result is the port's named result type. */
export interface PlacementDoorHandlers {
  verifyPlacementEnrollment(ctx: EpServeContext): Promise<VerifyPlacementResult>;
  enrollmentEffectStatus(ctx: EpServeContext): Promise<PlacementEffectStatusResult>;
  closeEnrollmentEffect(ctx: EpServeContext): Promise<PlacementEffectStatusResult>;
  retirePlacementEnrollment(ctx: EpServeContext): Promise<PlacementRetireResult>;
}

/** The four placement handlers. `placement.configured` is the boot-time fact: a plane without the
 *  reconciler, authenticator and role policy refuses `unimplemented` (permanent). A configured plane
 *  whose port is not built yet refuses `unavailable` (transient, retry). `placement.port` reads the
 *  built authority per request. */
export function createPlacementDoorHandlers(
  placement: { configured: boolean; port: () => PlacementEnrollmentAuthority | undefined },
): PlacementDoorHandlers {
  const requirePort = (): PlacementEnrollmentAuthority => {
    if (!placement.configured) throw new EpEnvelopeError("unimplemented", "placement enrollment ports are not configured");
    const port = placement.port();
    if (port === undefined) throw new EpEnvelopeError("unavailable", "auth service is still starting placement enrollment; retry shortly");
    return port;
  };
  return {
    verifyPlacementEnrollment: async (ctx: EpServeContext) => {
      const port = requirePort();
      const args = ctx.request.args as { identity: unknown; claim: unknown };
      return port.verifyPlacementEnrollment({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, request: { identity: args.identity, claim: args.claim } });
    },
    enrollmentEffectStatus: async (ctx: EpServeContext) => {
      const port = requirePort();
      const args = ctx.request.args as { effectId: string };
      return port.enrollmentEffectStatus({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, effectId: args.effectId });
    },
    closeEnrollmentEffect: async (ctx: EpServeContext) => {
      const port = requirePort();
      const args = ctx.request.args as { effectId: string; fenceId: string };
      return port.closeEnrollmentEffect({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, effectId: args.effectId, fenceId: args.fenceId });
    },
    retirePlacementEnrollment: async (ctx: EpServeContext) => {
      const port = requirePort();
      const args = ctx.request.args as { operationId: string; identity: EnrollmentIdentity; fenceId: string };
      return port.retirePlacementEnrollment({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, operationId: args.operationId, identity: args.identity, fenceId: args.fenceId });
    },
  };
}
