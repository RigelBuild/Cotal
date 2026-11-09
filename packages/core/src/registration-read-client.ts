import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { NatsConnection } from "@nats-io/transport-node";
import { managerRegistrationFamilySubject } from "./endpoint-subjects.js";

export interface RegistrationReadEntry { value: Uint8Array; revision: number; operation: "PUT" | "DEL" | "PURGE" }
export async function requestManagerRegistrationRead(nc: NatsConnection, space: string, owner: string, instanceId: string, request: { kind: "read"; key: string } | { kind: "generation"; targetInstanceId: string }): Promise<RegistrationReadEntry | number | null> {
  const subject = managerRegistrationFamilySubject(space, owner, instanceId), nonce = randomBytes(18).toString("base64url");
  const sub = nc.subscribe(`${subject}.reply.${nonce}`, { max: 1 }), abort = new AbortController();
  try {
    await nc.flush();
    const next = sub[Symbol.asyncIterator]().next();
    nc.publish(subject, new TextEncoder().encode(JSON.stringify({ nonce, ...request })));
    const result = await Promise.race([next, delay(5000, undefined, { signal: abort.signal }).then(() => { throw new Error("registration read timed out"); })]);
    if (result.done) throw new Error("registration read subscription closed");
    const raw: unknown = JSON.parse(new TextDecoder().decode(result.value.data));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("nonce" in raw) || raw.nonce !== nonce) throw new Error("invalid registration read reply");
    if (request.kind === "generation") {
      if (Object.keys(raw).length !== 2 || !("generation" in raw) || typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 0) throw new Error("invalid registration generation reply");
      return raw.generation;
    }
    if (Object.keys(raw).length === 2 && "absent" in raw && raw.absent === true) return null;
    if (Object.keys(raw).length !== 4 || !("value" in raw) || typeof raw.value !== "string" || !("revision" in raw) || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !("operation" in raw) || (raw.operation !== "PUT" && raw.operation !== "DEL" && raw.operation !== "PURGE")) throw new Error("invalid registration read reply");
    return { value: Buffer.from(raw.value, "base64"), revision: raw.revision, operation: raw.operation };
  } finally { abort.abort(); sub.unsubscribe(); }
}
