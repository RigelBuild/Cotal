import { assertLifecycleToken, dmDurable, dmStream, unicastSubject } from "./subjects.js";
import type { MintOpts, MintPrincipal } from "./provision.js";

export function publicSeatPermissions(space: string, pr: MintPrincipal, opts: MintOpts, inbox: string): Record<string, unknown> {
  if (opts.endpointCapabilities !== undefined || opts.capabilities !== undefined || opts.role !== undefined ||
      opts.allowPublish !== undefined || opts.allowSubscribe !== undefined || opts.listing !== undefined || opts.listingSeam !== undefined)
    throw new Error("permissionsFor(agent): dmOnly cannot carry other permission options");
  if (!pr.lifecycleUid)
    throw new Error("permissionsFor(agent): dmOnly requires lifecycleUid");
  const dm = dmStream(space);
  const durable = dmDurable(pr.owner, pr.actor, assertLifecycleToken(pr.lifecycleUid));
  return {
    pub: { allow: [unicastSubject(space, "*", "*", pr.owner, pr.actor), `$JS.API.CONSUMER.INFO.${dm}.${durable}`, `$JS.API.CONSUMER.MSG.NEXT.${dm}.${durable}`, `$JS.ACK.${dm}.${durable}.>`] },
    sub: { allow: [inbox] },
  };
}
