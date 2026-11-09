import { randomBytes } from "node:crypto";
import { assertLifecycleToken, assertNonce, assertValidOwnerToken, epcredFamilyPrefix, managerRegistrationFamilyFilter, managerRegistrationFamilyReplyFilter, managerRegistrationFamilySubject, parseLedgerRow, remoteManagerServePrincipal, serveIssuanceGateKv } from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { openAuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import type { AuthLedgerScanner } from "./ledger-scanner.js";

export async function openRegistrationFamilyScan(opts: Pick<AuthorityClientOpts, "server" | "space" | "dataAccount" | "log" | "onConnection"> & { scanner: AuthLedgerScanner; authKv: KV; probeDropChunk?: (seq: number, total: number) => boolean }) {
  const client = await openAuthorityClient({ ...opts, label: `cotal:registration-family:${opts.space}`,
    grants: () => ({ publish: [managerRegistrationFamilyReplyFilter(opts.space)], subscribe: [managerRegistrationFamilyFilter(opts.space)] }) });
  const sub = client.nc.subscribe(managerRegistrationFamilyFilter(opts.space));
  try { await client.nc.flush(); } catch (error) { sub.unsubscribe(); await client.close(); throw error; }
  const running = (async () => {
    for await (const msg of sub) {
      let reply: string | undefined;
      try {
        const parts = msg.subject.split(".");
        const owner = assertValidOwnerToken(parts.at(-2) ?? ""), iid = assertLifecycleToken(parts.at(-1) ?? "", "instanceId");
        if (msg.subject !== managerRegistrationFamilySubject(opts.space, owner, iid)) throw new Error("invalid scan subject");
        const body: unknown = JSON.parse(new TextDecoder().decode(msg.data));
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("nonce" in body) || typeof body.nonce !== "string") throw new Error("invalid scan request");
        reply = `${msg.subject}.reply.${assertNonce(body.nonce)}`;
        const gate = await serveIssuanceGateKv(opts.authKv, opts.space, { endpoint: "manager", instanceId: iid }).observe();
        if (!gate || gate.state === "retired" || gate.principal !== remoteManagerServePrincipal(owner, iid)) throw new Error("manager gate does not match requester");
        const prefix = `${epcredFamilyPrefix("manager", iid)}.`;
        const rows = (await opts.scanner.scanEndpointCredentialFamily("manager", iid)).map(entry => {
          if (!entry.key.startsWith(prefix) || (entry.op && entry.op !== "PUT")) throw new Error("invalid family evidence");
          const row = parseLedgerRow(entry.data, entry.key);
          return { credentialId: row.credentialId, holderPrincipal: row.holderPrincipal, state: row.state, exp: row.exp,
            sourceChain: row.sourceChain, ...(row.serviceConnection ? { serviceConnection: row.serviceConnection } : {}) };
        });
        const max = (client.nc.info?.max_payload ?? 0) - 1024;
        if (max <= 0) throw new Error("broker payload limit unavailable");
        const chunks: typeof rows[] = [[]];
        let size = 0;
        for (const row of rows) {
          const length = Buffer.byteLength(JSON.stringify(row)) + 1;
          if (length > max) throw new Error("registration family row exceeds payload limit");
          if (size + length > max) { chunks.push([]); size = 0; }
          chunks[chunks.length - 1]!.push(row); size += length;
        }
        const scanId = randomBytes(18).toString("base64url");
        for (let seq = 0; seq < chunks.length; seq++) {
          const last = seq === chunks.length - 1;
          if (opts.probeDropChunk?.(seq, chunks.length)) continue;
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce: body.nonce, scanId, seq, total: chunks.length, rows: chunks[seq], ...(last ? { rowCount: rows.length, complete: true } : {}) })));
        }
      } catch (error) {
        opts.log(`registration family scan refused: ${error instanceof Error ? error.message : String(error)}`);
        if (reply) client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ error: "registration family scan failed" })));
      }
    }
  })();
  return { close: async () => { sub.unsubscribe(); await running; await client.close(); } };
}
