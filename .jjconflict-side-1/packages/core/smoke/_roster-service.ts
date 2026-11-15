import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { AUTH_ROSTER_INPUT_SCHEMA, AUTH_ROSTER_OUTPUT_SCHEMA, answerAuthRoster, openAuthRosterReader, serviceContractTable, contractDigest, contractStoreContext, contractArtifactCanonicalBytes, publishContractArtifact, registerServingInstance, serveEndpoint, recordsBucket, epAuthBucket, provisionEndpointGateOpen, endpointRegistrationBarrier, serveIssuanceGateKv, principalKey, DEV_OWNER, standaloneConnectOpts, mintLifecycleUid, newIdentity, mintCreds, type SpaceAuth } from "../src/index.js";

export async function startRosterFixture(space: string, servers: string, auth: SpaceAuth): Promise<() => Promise<void>> {
  const iid = mintLifecycleUid();
  const serveId = newIdentity();
  const executorCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: iid } });
  const exec = await connect({ servers, ...standaloneConnectOpts({ creds: executorCreds, tls: false }) });
  const kvm = new Kvm(exec);
  const records = await kvm.open(recordsBucket(space));
  const authKv = await kvm.open(epAuthBucket(space));
  const table = serviceContractTable([{ name: "roster", input: AUTH_ROSTER_INPUT_SCHEMA, output: AUTH_ROSTER_OUTPUT_SCHEMA }]);
  const contract = table.contracts.roster!;
  const document = { urn: "ai.cotal.manager", revision: 1, attributes: [], events: [], commands: [{ name: "roster", class: "ephemeral", targeted: false, capability: "manager.read", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest }] };
  const root = contractDigest(document);
  const manifest = { v: 1, root, members: [] as string[] };
  const closure = contractDigest(manifest);
  const artifacts = new Map<string, unknown>([[root, document], [closure, manifest]]);
  const readClusterArtifact = (digest: string) => artifacts.get(digest);
  const store = await contractStoreContext(exec, space);
  for (const value of [...table.artifactValues(), document, manifest]) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
  await provisionEndpointGateOpen(authKv, { endpoint: "manager", instanceId: iid, principal: principalKey(DEV_OWNER, serveId.id).key });
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId: iid, opId: mintLifecycleUid() });
  const authority = { authorize: (name: string, owner: string) => ({ authorized: name === "manager" && owner === DEV_OWNER, revision: 0 }) };
  const { grant } = await registerServingInstance(records, { space, spec: { endpoint: "manager", owner: DEV_OWNER, clusterDigests: [closure], protocol: { v: 1 } }, instanceId: iid, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact });
  const serveCreds = await mintCreds(auth, serveId, "endpoint-serve", { endpointServe: grant, serveIssuance: serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: iid }) });
  const serveNc = await connect({ servers, ...standaloneConnectOpts({ creds: serveCreds, tls: false }) });
  const reader = await openAuthRosterReader({ server: servers, space, auth, log: console.error });
  const service = serveEndpoint(serveNc, space, grant, [{ command: "roster", contract, handler: (ctx) => {
    const args = ctx.request.args;
    return answerAuthRoster(reader, ctx, { ...(typeof args?.limit === "number" ? { limit: args.limit } : {}), ...(typeof args?.after === "string" ? { after: args.after } : {}) });
  } }], { public: true });
  await serveNc.flush();
  return async () => { await service.stop(); await reader.close(); await serveNc.drain(); await exec.drain(); };
}
