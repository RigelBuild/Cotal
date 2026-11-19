/**
 * Serving the seat contract through the Go reconciler's socket. RED STATE: the runner is not
 * implemented yet, so the smokes fail on it.
 */
import type { EpServeGrant } from "@cotal-ai/core";

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

/** Serve the seat contract on an authorized bundle, forwarding each call to the reconciler socket. */
export async function runReconcilerShim(_bundle: SeatsServeBundle, _opts: ReconcilerShimOptions): Promise<ReconcilerShimHandle> {
  throw new Error("runReconcilerShim is not implemented yet");
}
