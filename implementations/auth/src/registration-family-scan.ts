import { randomBytes } from "node:crypto";
import { assertCredentialIdTail, assertLifecycleToken, assertNonce, assertValidOwnerToken, epcredFamilyPrefix, epgateKey, eprepairKey, managerRegistrationFamilyFilter, managerRegistrationFamilyReplyFilter, managerRegistrationFamilySubject, parseLedgerRow, readEndpointGateGeneration, remoteManagerServePrincipal, serveIssuanceGateKv } from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { GOVERN_HEAD, RECORD_KINDS, recordAtomicKey, recordSpecKey, recordStatusKey } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import type { AuthLedgerScanner } from "./ledger-scanner.js";

export async function openRegistrationFamilyScan(opts: Pick<AuthorityClientOpts, "server" | "space" | "dataAccount" | "log" | "onConnection"> & { scanner: AuthLedgerScanner; authKv: KV; recordsKv: KV; probeScanStarted?: () => void; probeChunks?: (chunks: Record<string, unknown>[]) => Record<string, unknown>[] }) {
  const client = await openAuthorityClient({ ...opts, label: `cotal:registration-family:${opts.space}`,
    grants: () => ({ publish: [managerRegistrationFamilyReplyFilter(opts.space)], subscribe: [managerRegistrationFamilyFilter(opts.space)] }) });
  const sub = client.nc.subscribe(managerRegistrationFamilyFilter(opts.space));
  try { await client.nc.flush(); } catch (error) { sub.unsubscribe(); await client.close(); throw error; }
  const inFlight = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const handle = async (msg: { subject: string; data: Uint8Array }) => {
      let requestKey: string | undefined;
      let claimed = false;
      let reply: string | undefined;
      try {
        const parts = msg.subject.split(".");
        const owner = assertValidOwnerToken(parts.at(-2) ?? ""), iid = assertLifecycleToken(parts.at(-1) ?? "", "instanceId");
        if (msg.subject !== managerRegistrationFamilySubject(opts.space, owner, iid)) throw new Error("invalid scan subject");
        const body: unknown = JSON.parse(new TextDecoder().decode(msg.data));
        if (!body || typeof body !== "object" || Array.isArray(body) || !("nonce" in body) || typeof body.nonce !== "string") throw new Error("invalid scan request");
        reply = `${msg.subject}.reply.${assertNonce(body.nonce)}`;
        const gate = await serveIssuanceGateKv(opts.authKv, opts.space, { endpoint: "manager", instanceId: iid }).observe();
        if (!gate || gate.state === "retired" || gate.principal !== remoteManagerServePrincipal(owner, iid)) throw new Error("manager gate does not match requester");
        if ("kind" in body) {
          if (body.kind === "records" && Object.keys(body).length === 3 && "key" in body && typeof body.key === "string") {
            const keys = [recordSpecKey(RECORD_KINDS.svc, ["manager", iid]), recordStatusKey(RECORD_KINDS.svc, ["manager", iid]), recordAtomicKey(GOVERN_HEAD, ["manager"])];
            if (!keys.includes(body.key)) throw new Error("foreign registration records key");
            const entry = await opts.recordsKv.get(body.key);
            const result = entry ? { value: Buffer.from(entry.value).toString("base64"), revision: entry.revision, operation: entry.operation, created: entry.created.toISOString() } : { absent: true };
            client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce: body.nonce, ...result })));
            return;
          }
          if (body.kind === "read" && Object.keys(body).length === 3 && "key" in body && typeof body.key === "string") {
            const prefix = `${epcredFamilyPrefix("manager", iid)}.`;
            if (body.key.startsWith(prefix)) assertCredentialIdTail(body.key.slice(prefix.length), "credentialId");
            if (body.key !== epgateKey("manager", iid) && body.key !== eprepairKey("manager", iid) && !(body.key.startsWith(prefix) && body.key.length > prefix.length)) throw new Error("foreign registration read key");
            const entry = await opts.authKv.get(body.key);
            const result = entry ? { value: Buffer.from(entry.value).toString("base64"), revision: entry.revision, operation: entry.operation } : { absent: true };
            client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce: body.nonce, ...result })));
            return;
          }
          if (body.kind === "generation" && Object.keys(body).length === 3 && "targetInstanceId" in body && typeof body.targetInstanceId === "string") {
            const generation = await readEndpointGateGeneration(opts.authKv, { endpoint: "manager", instanceId: assertLifecycleToken(body.targetInstanceId) });
            client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce: body.nonce, generation })));
            return;
          }
          throw new Error("invalid registration read request");
        }
        if (Object.keys(body).length !== 1) throw new Error("invalid scan request");
        requestKey = `${owner}.${iid}`;
        if (inFlight.has(requestKey)) {
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce: body.nonce, error: "busy" })));
          return;
        }
        inFlight.add(requestKey); claimed = true;
        opts.probeScanStarted?.();
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
        const replies: Record<string, unknown>[] = chunks.map((chunkRows, seq) => ({ nonce: body.nonce, scanId, seq, total: chunks.length, rows: chunkRows, ...(seq === chunks.length - 1 ? { rowCount: rows.length, complete: true } : {}) }));
        for (const chunk of opts.probeChunks?.(replies) ?? replies)
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify(chunk)));
      } catch (error) {
        opts.log(`registration family scan refused: ${error instanceof Error ? error.message : String(error)}`);
        if (reply) client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ error: "registration family scan failed" })));
      } finally {
        if (claimed && requestKey) inFlight.delete(requestKey);
      }
  };
  const running = (async () => {
    for await (const msg of sub) {
      const task = handle(msg).catch(error => { opts.log(`registration family responder failed: ${String(error)}`); });
      tasks.add(task); void task.finally(() => tasks.delete(task));
    }
    await Promise.all(tasks);
  })();
  return { close: async () => { sub.unsubscribe(); await running; await client.close(); } };
}
