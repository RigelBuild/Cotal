import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { NatsConnection } from "@nats-io/transport-node";
import type { KV, KvEntry } from "@nats-io/kv";
import { recordsBucket } from "./endpoint-records.js";
import { managerRegistrationFamilySubject } from "./endpoint-subjects.js";

export class RegistrationFamilyBusyError extends Error {
  constructor() { super("registration family request busy"); this.name = "RegistrationFamilyBusyError"; }
}
export class RegistrationFamilyRefusedError extends Error {
  constructor() { super("registration family request refused"); this.name = "RegistrationFamilyRefusedError"; }
}
export interface RegistrationReadEntry { value: Uint8Array; revision: number; operation: "PUT" | "DEL" | "PURGE"; created?: Date }
export async function requestManagerRegistrationRead(nc: NatsConnection, space: string, owner: string, instanceId: string, request: { kind: "read" | "records"; key: string } | { kind: "generation"; targetInstanceId: string }): Promise<RegistrationReadEntry | number | null> {
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
    if ("error" in raw && raw.error === "busy" && Object.keys(raw).length === 2) throw new RegistrationFamilyBusyError();
    if ("error" in raw && raw.error === "refused" && Object.keys(raw).length === 2) throw new RegistrationFamilyRefusedError();
    if ("error" in raw && raw.error === "failed" && Object.keys(raw).length === 2) throw new Error("registration read failed");
    if (request.kind === "generation") {
      if (Object.keys(raw).length !== 2 || !("generation" in raw) || typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 0) throw new Error("invalid registration generation reply");
      return raw.generation;
    }
    if (Object.keys(raw).length === 2 && "absent" in raw && raw.absent === true) return null;
    if (Object.keys(raw).length !== (request.kind === "records" ? 5 : 4) || !("value" in raw) || typeof raw.value !== "string" || !("revision" in raw) || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !("operation" in raw) || (raw.operation !== "PUT" && raw.operation !== "DEL" && raw.operation !== "PURGE") || (request.kind === "records" && (!("created" in raw) || typeof raw.created !== "string" || Number.isNaN(Date.parse(raw.created))))) throw new Error("invalid registration read reply");
    return { value: Buffer.from(raw.value, "base64"), revision: raw.revision, operation: raw.operation, ...("created" in raw && typeof raw.created === "string" ? { created: new Date(raw.created) } : {}) };
  } finally { abort.abort(); sub.unsubscribe(); }
}

export function registrationRecordsKv(kv: KV, nc: NatsConnection, space: string, owner: string, instanceId: string): KV {
  return new Proxy(kv, { get(target, prop, receiver) {
    if (prop !== "get") return Reflect.get(target, prop, receiver);
    return async (key: string, opts?: { revision: number }): Promise<KvEntry | null> => {
      if (opts) throw new Error("historical registration records read is not supported");
      const entry = await requestManagerRegistrationRead(nc, space, owner, instanceId, { kind: "records", key });
      if (typeof entry === "number") throw new Error("invalid registration records read result");
      if (!entry) return null;
      if (!entry.created) throw new Error("registration records timestamp missing");
      return { ...entry, bucket: recordsBucket(space), key, rawKey: key, created: entry.created, length: entry.value.length,
        string: () => new TextDecoder().decode(entry.value), json: <T>() => JSON.parse(new TextDecoder().decode(entry.value)) as T };
    };
  } });
}
