/**
 * The shim's serve bundle, issued and renewed by auth into the reconciler Secret under its own key.
 * Red stub: the exports carry their real signatures so the smoke typechecks; each refuses until the
 * fix lands.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import type { Identity, SpaceAuth } from "@cotal-ai/core";
import type { KubeSecretStore } from "./kube-secret-store.js";
import type { ReconcilerRecordStore } from "./reconciler-credential.js";

/** The Secret key the shim reads its serve bundle from. The caller credential has its own key. */
export const RECONCILER_SERVE_KEY = "serve-bundle";

/** The endpoint the reconciler shim serves. Registered by auth; the shim never registers it. */
export const SEATS_ENDPOINT_NAME = "wave-seats";

/** The typed bundle the shim reads. The serve credential, plus the grant fields the shim needs to
 *  check its own identity. It holds no signer material and no caller rails. */
export interface ServeBundle {
  readonly version: 1;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly registrationRevision: number;
  /** The user JWT and nkey seed of the serve credential, in creds form. */
  readonly creds: string;
  /** The issue and expiry of the serve credential, in unix seconds. */
  readonly iat: number;
  readonly exp: number;
}

export interface IssueServeBundleOptions {
  auth: SpaceAuth;
  /** The Secret the serve bundle is written to. Patched on its own key only. */
  secrets: KubeSecretStore;
  /** Auth's record of the serve identity and instance, one per shim. */
  records: ReconcilerRecordStore;
  /** The live executor connection auth registers `wave-seats` through. */
  nc: NatsConnection;
  /** The serve identity the endpoint-serve credential is minted for. */
  serveIdentity: Identity;
  /** The owner the endpoint is registered under. */
  owner: string;
  /** The lifecycle uid of the serving instance. */
  instanceId: string;
  /** Re-reads the instance's issuance gate after registration to confirm it is open. */
  observeGate: () => Promise<{ state: string; processEpoch: number; registrationRevision: number } | null>;
}

/** Issue or renew the serve bundle for the registered `wave-seats` endpoint. Red stub. */
export function issueServeBundle(_opts: IssueServeBundleOptions): Promise<ServeBundle> {
  return Promise.reject(new Error("issueServeBundle is not implemented yet"));
}
