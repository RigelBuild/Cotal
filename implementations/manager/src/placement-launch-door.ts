/**
 * The placement launch door: the two endpoint handlers that serve the placement-only launch
 * operations on the manager endpoint, `prepare-launch` and `place`.
 *
 * The caller is the broker-authenticated subject on the request, never a body field. It is mapped
 * to a principal key here and forwarded to the port, which admits only the reconciler principal.
 * This door only forwards that principal and the validated args.
 */
import { EpEnvelopeError, principalKey, type EpServeContext } from "@cotal-ai/core";

/** The two placement launch operations the port serves. Each receives the caller principal key
 *  and the validated request. The reconciler principal check lives in the port, not here. */
export interface PlacementLaunchPort {
  prepareLaunch(input: { caller: string; request: unknown }): Promise<unknown>;
  place(input: { caller: string; request: unknown }): Promise<unknown>;
}

/** The placement launch handler pair. */
export interface PlacementLaunchHandlers {
  prepareLaunch(ctx: EpServeContext): Promise<unknown>;
  place(ctx: EpServeContext): Promise<unknown>;
}

/** The placement launch handlers. `placement.configured` is the boot-time fact: a manager without the
 *  reconciler principal refuses `unimplemented` (permanent). A configured manager whose port is not
 *  built yet refuses `unavailable` (transient, retry). `placement.port` reads the built port per
 *  request. */
export function createPlacementLaunchHandlers(
  placement: { configured: boolean; port: () => PlacementLaunchPort | undefined },
): PlacementLaunchHandlers {
  const requirePort = (): PlacementLaunchPort => {
    if (!placement.configured) throw new EpEnvelopeError("unimplemented", "placement launch ports are not configured");
    const port = placement.port();
    if (port === undefined) throw new EpEnvelopeError("unavailable", "manager is still starting placement launch; retry shortly");
    return port;
  };
  return {
    prepareLaunch: async (ctx: EpServeContext) => {
      const port = requirePort();
      return port.prepareLaunch({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, request: ctx.request.args });
    },
    place: async (ctx: EpServeContext) => {
      const port = requirePort();
      return port.place({ caller: principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, request: ctx.request.args });
    },
  };
}
