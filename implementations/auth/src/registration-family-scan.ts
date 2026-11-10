import { randomBytes } from "node:crypto";
import { assertCredentialIdTail, assertLifecycleToken, assertNonce, assertValidOwnerToken, epcredFamilyPrefix, epgateKey, eprepairKey, managerRegistrationFamilyFilter, managerRegistrationFamilyReplyFilter, managerRegistrationFamilySubject, parseLedgerRow, readEndpointGateGeneration, remoteManagerServePrincipal, serveIssuanceGateKv } from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { GOVERN_HEAD, RECORD_KINDS, recordAtomicKey, recordSpecKey, recordStatusKey } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import type { AuthLedgerScanner } from "./ledger-scanner.js";

class RegistrationFamilyAuthorizationError extends Error {}
export async function openRegistrationFamilyScan(opts: Pick<AuthorityClientOpts, "server" | "space" | "dataAccount" | "log" | "onConnection"> & { scanner: AuthLedgerScanner; authKv: KV; recordsKv: KV; probeScanStarted?: () => void; probePointRead?: (instanceId: string) => void | Promise<void>; probeChunks?: (chunks: Record<string, unknown>[]) => Iterable<Record<string, unknown>> }) {
  const client = await openAuthorityClient({ ...opts, label: `cotal:registration-family:${opts.space}`,
    grants: () => ({ publish: [managerRegistrationFamilyReplyFilter(opts.space)], subscribe: [managerRegistrationFamilyFilter(opts.space)] }) });
  const sub = client.nc.subscribe(managerRegistrationFamilyFilter(opts.space));
  try { await client.nc.flush(); } catch (error) { sub.unsubscribe(); await client.close(); throw error; }
  const inFlight = new Set<string>();
  const pointReadsByInstance = new Map<string, number>();
  let pointReadsTotal = 0;
  const tasks = new Set<Promise<void>>();
  const handle = async (msg: { subject: string; data: Uint8Array }) => {
    let requestKey: string | undefined;
    let claimed = false;
    let requestNonce: string | undefined;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const parts = msg.subject.split(".");
      const owner = assertValidOwnerToken(parts.at(-2) ?? ""), iid = assertLifecycleToken(parts.at(-1) ?? "", "instanceId");
      if (msg.subject !== managerRegistrationFamilySubject(opts.space, owner, iid)) throw new Error("invalid scan subject");
      const body: unknown = JSON.parse(new TextDecoder().decode(msg.data));
      if (!body || typeof body !== "object" || Array.isArray(body) || !("nonce" in body) || typeof body.nonce !== "string") throw new Error("invalid scan request");
      const nonce = requestNonce = assertNonce(body.nonce);
      const reply = `${msg.subject}.reply.${nonce}`;
      const pointRead = "kind" in body;
      let controller: AbortController | undefined;
      let deadline = 0;
      if (pointRead) {
        if (Object.keys(body).length !== 3) throw new Error("invalid registration read request");
      } else {
        if (Object.keys(body).length !== 2 || !("deadline" in body) || typeof body.deadline !== "number" || !Number.isSafeInteger(body.deadline) || body.deadline <= Date.now()) throw new Error("invalid scan request");
      }
      const gateEntry = await opts.authKv.get(epgateKey("manager", iid));
      const gate = await serveIssuanceGateKv(opts.authKv, opts.space, { endpoint: "manager", instanceId: iid, read: async () => gateEntry }).observe();
      if (!gate && pointRead && body.kind === "read" && Object.keys(body).length === 3 && "key" in body && body.key === epgateKey("manager", iid)) {
        client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, absent: true })));
        return;
      }
      // The owner may observe its own retired gate, but no other registration data.
      if (gate?.state === "retired" && gate.principal === remoteManagerServePrincipal(owner, iid) && pointRead && body.kind === "read" && "key" in body && body.key === epgateKey("manager", iid)) {
        const result = gateEntry ? { value: Buffer.from(gateEntry.value).toString("base64"), revision: gateEntry.revision, operation: gateEntry.operation } : { absent: true };
        client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, ...result })));
        return;
      }
      if (!gate || gate.state === "retired" || gate.principal !== remoteManagerServePrincipal(owner, iid)) throw new RegistrationFamilyAuthorizationError("manager gate does not match requester");
      if (pointRead) {
        const key = `${owner}.${iid}`, count = pointReadsByInstance.get(key) ?? 0;
        if (pointReadsTotal >= 256 || count >= 8) {
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, error: "busy" })));
          return;
        }
        pointReadsTotal++; pointReadsByInstance.set(key, count + 1); requestKey = `read:${key}`; claimed = true;
      } else {
        requestKey = `${owner}.${iid}`;
        if (inFlight.has(requestKey)) {
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, error: "busy" })));
          return;
        }
        inFlight.add(requestKey); claimed = true;
        if (!("deadline" in body) || typeof body.deadline !== "number") throw new Error("invalid scan request");
        deadline = Math.min(body.deadline, Date.now() + 5 * 60_000);
        controller = new AbortController();
        scanTimer = setTimeout(() => controller!.abort(), Math.max(0, deadline - Date.now()));
      }
      if (pointRead) {
        if (body.kind === "records" && Object.keys(body).length === 3 && "key" in body && typeof body.key === "string") {
          const keys = [recordSpecKey(RECORD_KINDS.svc, ["manager", iid]), recordStatusKey(RECORD_KINDS.svc, ["manager", iid]), recordAtomicKey(GOVERN_HEAD, ["manager"])];
          if (!keys.includes(body.key)) throw new RegistrationFamilyAuthorizationError("foreign registration records key");
          await opts.probePointRead?.(iid);
          const entry = await opts.recordsKv.get(body.key);
          const result = entry ? { value: Buffer.from(entry.value).toString("base64"), revision: entry.revision, operation: entry.operation, created: entry.created.toISOString() } : { absent: true };
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, ...result })));
          return;
        }
        if (body.kind === "read" && Object.keys(body).length === 3 && "key" in body && typeof body.key === "string") {
          const prefix = `${epcredFamilyPrefix("manager", iid)}.`;
          if (body.key.startsWith(prefix)) {
            try { assertCredentialIdTail(body.key.slice(prefix.length), "credentialId"); }
            catch { throw new RegistrationFamilyAuthorizationError("invalid registration credential key"); }
          }
          if (body.key !== epgateKey("manager", iid) && body.key !== eprepairKey("manager", iid) && !(body.key.startsWith(prefix) && body.key.length > prefix.length))
            throw new RegistrationFamilyAuthorizationError("foreign registration read key");
          await opts.probePointRead?.(iid);
          const entry = await opts.authKv.get(body.key);
          const result = entry ? { value: Buffer.from(entry.value).toString("base64"), revision: entry.revision, operation: entry.operation } : { absent: true };
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, ...result })));
          return;
        }
        if (body.kind === "generation" && Object.keys(body).length === 3 && "targetInstanceId" in body && typeof body.targetInstanceId === "string") {
          await opts.probePointRead?.(iid);
          const generation = await readEndpointGateGeneration(opts.authKv, { endpoint: "manager", instanceId: assertLifecycleToken(body.targetInstanceId) });
          client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ nonce, generation })));
          return;
        }
        throw new Error("invalid registration read request");
      }
      opts.probeScanStarted?.();
      const prefix = `${epcredFamilyPrefix("manager", iid)}.`;
      const rows = (await opts.scanner.scanEndpointCredentialFamily("manager", iid, controller!.signal)).map(entry => {
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
      const replies: Record<string, unknown>[] = chunks.map((chunkRows, seq) => ({ nonce, scanId, seq, total: chunks.length, rows: chunkRows, ...(seq === chunks.length - 1 ? { rowCount: rows.length, complete: true } : {}) }));
      for (const chunk of opts.probeChunks?.(replies) ?? replies) {
        if (Date.now() >= deadline) controller!.abort();
        controller!.signal.throwIfAborted();
        client.nc.publish(reply, new TextEncoder().encode(JSON.stringify({ ...chunk, nonce })));
      }
    } catch (error) {
      const kind = error instanceof RegistrationFamilyAuthorizationError ? "refused" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      opts.log(`registration family request ${kind}: ${message}`);
      if (requestNonce) client.nc.publish(`${msg.subject}.reply.${requestNonce}`, new TextEncoder().encode(JSON.stringify({ nonce: requestNonce, error: kind })));
    } finally {
      if (scanTimer !== undefined) clearTimeout(scanTimer);
      if (claimed && requestKey?.startsWith("read:")) {
        const key = requestKey.slice("read:".length), count = pointReadsByInstance.get(key) ?? 0;
        if (count <= 1) pointReadsByInstance.delete(key); else pointReadsByInstance.set(key, count - 1);
        pointReadsTotal--;
      } else if (claimed && requestKey) inFlight.delete(requestKey);
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
