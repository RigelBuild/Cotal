/**
 * The shim's serve bundle, issued and renewed by auth into the reconciler Secret under its own key.
 * Auth registers `wave-seats` through the native gate ceremony, mints the shim's serve credential
 * with the same issuance fence the registry uses, and patches only the serve key.
 */
import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError, authorizeServeGrant, buildClusterArtifacts, credsClaims, epAuthBucket,
  mintCreds, recordsBucket, registerServiceInstance, serveIssuanceGateKv, type EpGateState, type Identity, type SpaceAuth,
} from "@cotal-ai/core";
import { seatClusterDocument, seatContractArtifactValues, SEATS_ENDPOINT } from "@cotal-ai/reconciler-shim";
import { contractArtifactReader, registerSelfAuthorizedInstance, selfNameAuthority } from "./service-registration.js";
import type { KubeSecretStore } from "./kube-secret-store.js";
import type { ReconcilerRecordStore } from "./reconciler-credential.js";

/** The Secret key the shim reads its serve bundle from. The caller credential has its own key. */
export const RECONCILER_SERVE_KEY = "serve-bundle";

/** The endpoint the reconciler shim serves. Auth registers it; the shim never registers it. */
export const SEATS_ENDPOINT_NAME = SEATS_ENDPOINT;

/** The typed bundle the shim reads. The serve credential in creds form, plus the grant fields the
 *  shim checks its identity against. It holds no signer material and no caller rails. */
export interface ServeBundle {
  readonly version: 1;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly registrationRevision: number;
  /** The serve credential as creds text: the user JWT and the user nkey seed. */
  readonly creds: string;
  /** The serve credential's issue and expiry, in unix seconds. */
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
  /** Re-reads the instance's issuance gate, so the grant is authorized against the live gate. */
  observeGate: () => Promise<EpGateState | null>;
}

/** Register `wave-seats`, mint the shim's serve credential, and write it under the serve key. */
export async function issueServeBundle(opts: IssueServeBundleOptions): Promise<ServeBundle> {
  const { auth, secrets, nc, serveIdentity, owner, instanceId } = opts;
  const space = auth.space;
  const cluster = buildClusterArtifacts(seatClusterDocument());
  const artifacts = [...seatContractArtifactValues(), cluster.document, cluster.manifest];
  const registration = await registerSelfAuthorizedInstance(nc, {
    space, endpoint: SEATS_ENDPOINT_NAME, instanceId,
    principal: `${owner}.${serveIdentity.id}`,
    clusterDigest: cluster.closureDigest, artifacts,
  }, registerServiceInstance);
  const kvm = new Kvm(nc);
  const authKv = await kvm.open(epAuthBucket(space));
  const recordsKv = await kvm.open(recordsBucket(space));
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: SEATS_ENDPOINT_NAME, instanceId });
  const readProcessEpoch = async (): Promise<number> => {
    const current = await gate.observe();
    if (current === null) throw new EpEnvelopeError("unavailable", "the wave-seats issuance gate is missing");
    return current.processEpoch;
  };
  const grant = await authorizeServeGrant(recordsKv, {
    space, endpoint: SEATS_ENDPOINT_NAME, instanceId, epoch: registration.processEpoch,
    holder: { owner }, authority: selfNameAuthority(SEATS_ENDPOINT_NAME),
    readClusterArtifact: contractArtifactReader(artifacts), readProcessEpoch,
  });
  const creds = await mintCreds(auth, serveIdentity, "endpoint-serve", {
    endpointServe: grant, serveIssuance: gate,
  });
  const claims = credsClaims(creds);
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number")
    throw new EpEnvelopeError("internal", "the serve credential must carry a bounded iat and exp");
  await secrets.put(RECONCILER_SERVE_KEY, JSON.stringify({
    version: 1,
    endpoint: SEATS_ENDPOINT_NAME,
    instanceId,
    epoch: grant.epoch,
    registrationRevision: grant.registrationRevision,
    creds,
    iat: claims.iat,
    exp: claims.exp,
  }));
  return { version: 1, endpoint: SEATS_ENDPOINT_NAME, instanceId, epoch: grant.epoch, registrationRevision: grant.registrationRevision, creds, iat: claims.iat, exp: claims.exp };
}
