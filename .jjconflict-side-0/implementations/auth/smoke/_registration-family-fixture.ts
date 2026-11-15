import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { epAuthBucket, mintCreds, newIdentity, provisionEndpointGateOpen, recordsBucket, remoteManagerServePrincipal, standaloneConnectOpts, type SpaceAuth } from "@cotal-ai/core";
import { openAuthorityClient } from "../src/authority-client.js";
import { authorityScannerGrants, makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { openRegistrationFamilyScan } from "../src/registration-family-scan.js";

export interface RegistrationFixture {
  prepare(owner: string, instanceId: string): Promise<void>;
  close(): Promise<void>;
}

export async function openRegistrationFixture(server: string, space: string, auth: SpaceAuth): Promise<RegistrationFixture> {
  const scannerClient = await openAuthorityClient({ server, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, label: "supervise-dial-scan", grants: id => authorityScannerGrants(space, id), log: console.error });
  const provisioner = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }) });
  const issuer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "issuer", { principal: { owner: "local", actor: "host" } }), tls: false }) });
  const responder = await openRegistrationFamilyScan({ server, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, log: console.error, scanner: makeLedgerScannerOverConnection(scannerClient.nc, space), authKv: await new Kvm(issuer).open(epAuthBucket(space)), recordsKv: await new Kvm(provisioner).open(recordsBucket(space)) });
  return {
    prepare: async (owner: string, instanceId: string) => {
      const writer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false }) });
      try {
        await provisionEndpointGateOpen(await new Kvm(writer).open(epAuthBucket(space)), { endpoint: "manager", instanceId, principal: remoteManagerServePrincipal(owner, instanceId) });
      } finally { await writer.close(); }
    },
    close: async () => { await responder.close(); await scannerClient.close(); await issuer.close(); await provisioner.close(); },
  };
}
