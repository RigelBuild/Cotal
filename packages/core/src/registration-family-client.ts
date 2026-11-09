import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { NatsConnection } from "@nats-io/transport-node";
import type { EpServeLedgerRow } from "./endpoint-service.js";
import { managerRegistrationFamilySubject } from "./endpoint-subjects.js";
import { RegistrationFamilyBusyError } from "./registration-read-client.js";
import { parseManagerRegistrationFamilyRows } from "./registration-family.js";

export async function requestManagerRegistrationFamily(nc: NatsConnection, space: string, owner: string, instanceId: string, timeoutMs = 5 * 60_000): Promise<EpServeLedgerRow[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("registration family scan timeout must be positive");
  const deadline = Date.now() + Math.min(timeoutMs, 5 * 60_000);
  const subject = managerRegistrationFamilySubject(space, owner, instanceId), nonce = randomBytes(18).toString("base64url");
  const sub = nc.subscribe(`${subject}.reply.${nonce}`), abort = new AbortController();
  const rows: EpServeLedgerRow[] = [], ids = new Set<string>();
  let scanId = "", total = 0, seq = 0;
  try {
    await nc.flush();
    const iterator = sub[Symbol.asyncIterator]();
    nc.publish(subject, new TextEncoder().encode(JSON.stringify({ nonce, deadline })));
    const timeout = (async () => { await delay(Math.max(0, deadline - Date.now()), undefined, { signal: abort.signal }); throw new Error("registration family scan timed out"); })();
    while (true) {
      const msg = await Promise.race([iterator.next(), timeout]);
      if (Date.now() >= deadline) throw new Error("registration family scan timed out");
      if (msg.done) throw new Error("registration family reply subscription closed");
      const chunk: unknown = JSON.parse(new TextDecoder().decode(msg.value.data));
      if (chunk && typeof chunk === "object" && "nonce" in chunk && chunk.nonce === nonce && "error" in chunk && chunk.error === "busy" && Object.keys(chunk).length === 2) throw new RegistrationFamilyBusyError();
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) || Object.keys(chunk).some(k => !["nonce", "scanId", "seq", "total", "rows", "rowCount", "complete"].includes(k)) ||
        !("nonce" in chunk) || chunk.nonce !== nonce || !("scanId" in chunk) || typeof chunk.scanId !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(chunk.scanId) ||
        !("seq" in chunk) || chunk.seq !== seq || !("total" in chunk) || typeof chunk.total !== "number" || !Number.isSafeInteger(chunk.total) || chunk.total < 1 || chunk.total > 100000 ||
        !("rows" in chunk) || !Array.isArray(chunk.rows)) throw new Error("invalid registration family chunk");
      if (seq === 0) { scanId = chunk.scanId; total = chunk.total; }
      if (chunk.scanId !== scanId || chunk.total !== total || seq >= total) throw new Error("inconsistent registration family chunks");
      const last = seq === total - 1;
      if (last ? !("complete" in chunk && chunk.complete === true && "rowCount" in chunk && chunk.rowCount === rows.length + chunk.rows.length) : ("complete" in chunk || "rowCount" in chunk)) throw new Error("incomplete registration family chunks");
      for (const row of parseManagerRegistrationFamilyRows(chunk.rows, instanceId)) {
        if (ids.has(row.credentialId)) throw new Error("duplicate registration family credential");
        ids.add(row.credentialId); rows.push(row);
      }
      if (last) return rows;
      seq++;
    }
  } finally { abort.abort(); sub.unsubscribe(); }
}
