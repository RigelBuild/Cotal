/**
 * Serving the seat contract through the Go reconciler's socket. The shim holds no authority: it
 * validates each body against the closed schema and forwards it; Go authorizes and journals.
 */
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { dialerFor, EpEnvelopeError, idFromCreds, serveEndpoint, type EpCommandDef, type EpServeContext, type EpServeGrant, type EpServeHandle } from "@cotal-ai/core";
import { MAX_HANDOFF_BYTES, SEAT_COMMANDS, SEAT_CONTRACTS } from "./contract.js";
import { DEFAULT_SOCKET_DEADLINE_MS, forwardToReconciler } from "./forward.js";

// Leave the reply this much of the caller's budget to travel back.
const REPLY_MARGIN_MS = 500;

/** An authorized, scoped serve bundle: the endpoint grant plus a serve credential source. */
export interface SeatsServeBundle {
  servers: string;
  space: string;
  tls: boolean;
  grant: EpServeGrant;
  /** Returns the CURRENT serve credential; read on every (re)connect. */
  creds: () => string;
}

export interface ReconcilerShimOptions {
  /** The Go reconciler's Unix socket. */
  socketPath: string;
  /** The longest wait for one reconciler reply. */
  socketDeadlineMs?: number;
}

export interface ReconcilerShimHandle {
  readonly endpoint: string;
  readonly instanceId: string;
  readonly epoch: number;
  /** Stop serving and close the connection, each within `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** Resolves when the serve connection closes for good. */
  closed: Promise<Error | undefined>;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref());
  return Promise.race([p, timeout]);
}

/** The socket deadline: `deadlineMs`, cut to what is left of the caller's budget. */
function socketDeadline(ctx: EpServeContext, deadlineMs: number): number {
  const budget = ctx.request.deadlineMs;
  if (budget === undefined) return deadlineMs;
  const spent = ctx.receivedAtMonotonicMs !== undefined ? performance.now() - ctx.receivedAtMonotonicMs : 0;
  return Math.max(1, Math.min(deadlineMs, budget - spent - REPLY_MARGIN_MS));
}

/** One def per seat command; each forwards the subject unchanged and the validated args. */
export function seatCommandDefs(socketPath: string, deadlineMs: number): EpCommandDef[] {
  return SEAT_COMMANDS.map((command) => ({
    command,
    contract: SEAT_CONTRACTS[command],
    handler: (ctx) => {
      const args = ctx.request.args ?? {};
      if (command === "handoff-upload") {
        const content = String(args.content);
        const decoded = (content.length / 4) * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
        if (content.length % 4 !== 0 || decoded > MAX_HANDOFF_BYTES)
          throw new EpEnvelopeError("bad-request", `handoff content must be padded base64 of at most ${MAX_HANDOFF_BYTES} bytes`);
      }
      return forwardToReconciler(socketPath, ctx.subject, args, socketDeadline(ctx, deadlineMs));
    },
  }));
}

/** Serve the seat contract on an authorized bundle, forwarding each call to the reconciler socket. */
export async function runReconcilerShim(bundle: SeatsServeBundle, opts: ReconcilerShimOptions): Promise<ReconcilerShimHandle> {
  const enc = new TextEncoder();
  const nc: NatsConnection = await dialerFor(bundle.servers)({
    servers: bundle.servers,
    ...(bundle.tls ? { tls: {} } : {}),
    authenticator: (nonce?: string) => credsAuthenticator(enc.encode(bundle.creds()))(nonce),
    inboxPrefix: `_INBOX_${idFromCreds(bundle.creds())}`,
    maxReconnectAttempts: -1,
  });
  let handle: EpServeHandle;
  try {
    const defs = seatCommandDefs(opts.socketPath, opts.socketDeadlineMs ?? DEFAULT_SOCKET_DEADLINE_MS);
    handle = serveEndpoint(nc, bundle.space, bundle.grant, defs, { public: true });
  } catch (e) {
    await nc.drain().catch(() => nc.close());
    throw e;
  }
  return {
    endpoint: bundle.grant.endpoint,
    instanceId: bundle.grant.instanceId,
    epoch: bundle.grant.epoch,
    closed: nc.closed().then((e) => e ?? undefined),
    async stop(graceMs = 10_000) {
      await within(handle.stop(), graceMs);
      await within(nc.drain().catch(() => nc.close()), graceMs);
      if (!nc.isClosed()) await nc.close().catch(() => {});
    },
  };
}
