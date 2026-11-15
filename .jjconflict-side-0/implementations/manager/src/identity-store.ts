import { randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EpEnvelopeError, ensureDirNoSymlink, mintLifecycleUid } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";
import { lockExclusiveNb } from "@cotal-ai/seat";

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export type IdentityIssuance = {
  generation: string;
  iat: number;
  exp: number;
  acceptedToken: string;
  issuanceId: string;
  credentialId?: string;
  state: "pending" | "issued" | "retiring" | "retired";
};

export type IdentityRecord = {
  version: 1;
  name: string;
  lifecycleUid: string;
  minter: string;
  reservedAt: number;
  touchedAt: number;
  retiredAt?: number;
  publicKey?: string;
  issuance?: IdentityIssuance;
  renewal?: { issuanceId: string; iat: number; exp: number };
  initialIssuance?: IdentityIssuance;
  terminalizing?: boolean;
  retirementExpiry?: number;
};

const KEYS = new Set(["version", "name", "lifecycleUid", "minter", "reservedAt", "touchedAt", "retiredAt", "publicKey", "issuance", "renewal", "initialIssuance", "terminalizing", "retirementExpiry"]);
const ISSUANCE_KEYS = new Set(["generation", "iat", "exp", "acceptedToken", "issuanceId", "credentialId", "state"]);
const UID = /^[a-z0-9]{26,32}$/;
const USER_NKEY = /^U[A-Z2-7]{55}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function object(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function parseIssuance(raw: unknown): IdentityIssuance | undefined {
  if (raw === undefined) return undefined;
  if (!object(raw) || Object.keys(raw).some((key) => !ISSUANCE_KEYS.has(key)) ||
      typeof raw.generation !== "string" || !/^[0-9a-f]{32}$/.test(raw.generation) ||
      !Number.isSafeInteger(raw.iat) || !Number.isSafeInteger(raw.exp) ||
      typeof raw.acceptedToken !== "string" || !HEX32.test(raw.acceptedToken) ||
      typeof raw.issuanceId !== "string" || !UID.test(raw.issuanceId) ||
      (raw.credentialId !== undefined && (typeof raw.credentialId !== "string" || !/^sha256-[0-9a-f]{64}$/.test(raw.credentialId))) ||
      !["pending", "issued", "retiring", "retired"].includes(String(raw.state)))
    throw new Error("invalid identity issuance record");
  return {
    generation: raw.generation,
    iat: raw.iat as number,
    exp: raw.exp as number,
    acceptedToken: raw.acceptedToken,
    issuanceId: raw.issuanceId,
    ...(raw.credentialId === undefined ? {} : { credentialId: raw.credentialId as string }),
    state: raw.state as IdentityIssuance["state"],
  };
}

export function parseIdentityRecord(raw: unknown): IdentityRecord {
  if (!object(raw) || Object.keys(raw).some((key) => !KEYS.has(key)) || raw.version !== 1 ||
      typeof raw.name !== "string" || !raw.name || typeof raw.lifecycleUid !== "string" || !UID.test(raw.lifecycleUid) ||
      typeof raw.minter !== "string" || !raw.minter || !Number.isSafeInteger(raw.reservedAt) || !Number.isSafeInteger(raw.touchedAt) ||
      (raw.retiredAt !== undefined && !Number.isSafeInteger(raw.retiredAt)) ||
      (raw.terminalizing !== undefined && raw.terminalizing !== true) ||
      (raw.retirementExpiry !== undefined && (!Number.isSafeInteger(raw.retirementExpiry) || raw.terminalizing !== true)) ||
      (raw.publicKey !== undefined && (typeof raw.publicKey !== "string" || !USER_NKEY.test(raw.publicKey))))
    throw new Error("invalid identity record");
  const issuance = parseIssuance(raw.issuance);
  const initialIssuance = parseIssuance(raw.initialIssuance);
  let renewal: IdentityRecord["renewal"];
  if (raw.renewal !== undefined) {
    if (!object(raw.renewal) || Object.keys(raw.renewal).some((key) => !["issuanceId", "iat", "exp"].includes(key)) ||
        typeof raw.renewal.issuanceId !== "string" || !UID.test(raw.renewal.issuanceId) ||
        !Number.isSafeInteger(raw.renewal.iat) || !Number.isSafeInteger(raw.renewal.exp) || issuance?.state !== "issued")
      throw new Error("invalid identity renewal intent");
    renewal = { issuanceId: raw.renewal.issuanceId, iat: raw.renewal.iat as number, exp: raw.renewal.exp as number };
  }
  if (raw.retiredAt !== undefined && issuance !== undefined && issuance.state !== "retired")
    throw new Error("retired identity issuance must be terminal");
  return {
    version: 1,
    name: raw.name,
    lifecycleUid: raw.lifecycleUid,
    minter: raw.minter,
    reservedAt: raw.reservedAt as number,
    touchedAt: raw.touchedAt as number,
    ...(raw.retiredAt === undefined ? {} : { retiredAt: raw.retiredAt as number }),
    ...(raw.publicKey === undefined ? {} : { publicKey: raw.publicKey as string }),
    ...(issuance === undefined ? {} : { issuance }),
    ...(renewal === undefined ? {} : { renewal }),
    ...(initialIssuance === undefined ? {} : { initialIssuance }),
    ...(raw.terminalizing === true ? { terminalizing: true } : {}),
    ...(raw.retirementExpiry === undefined ? {} : { retirementExpiry: raw.retirementExpiry as number }),
  };
}

function sameIssuance(a: IdentityIssuance | undefined, b: IdentityIssuance | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined &&
    a.generation === b.generation && a.iat === b.iat && a.exp === b.exp &&
    a.acceptedToken === b.acceptedToken && a.issuanceId === b.issuanceId && a.credentialId === b.credentialId && a.state === b.state;
}

function cloneRecord(record: IdentityRecord): IdentityRecord {
  return { ...record, ...(record.issuance === undefined ? {} : { issuance: { ...record.issuance } }), ...(record.initialIssuance === undefined ? {} : { initialIssuance: { ...record.initialIssuance } }), ...(record.renewal === undefined ? {} : { renewal: { ...record.renewal } }) };
}

function identityError(code: ConstructorParameters<typeof EpEnvelopeError>[0], message: string): EpEnvelopeError {
  return new EpEnvelopeError(code, message, undefined, "not-executed");
}

export class IdentityStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #records: IdentityRecord[] = [];

  constructor(root: string, space: string, managerInstanceId: string) {
    const dir = ensureDirNoSymlink(root, ".cotal");
    this.#path = join(dir, `manager-identities.${spaceKey(space)}.${managerInstanceId}.json`);
    this.#lockPath = `${this.#path}.lock`;
  }

  #withLock<T>(action: () => T): T {
    let fd: number | undefined;
    try {
      fd = openSync(this.#lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("identity state lock is not a regular file owned by this user");
      fchmodSync(fd, 0o600);
      while (!lockExclusiveNb(fd)) Atomics.wait(LOCK_WAIT, 0, 0, 25);
      this.#load();
      return action();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  #current(name: string): IdentityRecord | undefined {
    for (let index = this.#records.length - 1; index >= 0; index--) {
      const row = this.#records[index];
      if (row?.name === name) return row;
    }
    return undefined;
  }

  #indexByUid(uid: string): number {
    return this.#records.findIndex((row) => row.lifecycleUid === uid);
  }

  #load(): void {
    this.#records.length = 0;
    if (!existsSync(this.#path)) return;
    let fd: number | undefined;
    let raw: string;
    try {
      fd = openSync(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("identity state is not a regular file owned by this user");
      raw = readFileSync(fd, "utf8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || Object.keys(parsed).length !== 2 || parsed.version !== 1 || !Array.isArray(parsed.records))
      throw new Error("invalid identity state envelope");
    const uids = new Set<string>();
    const latestByName = new Map<string, IdentityRecord>();
    for (const raw of parsed.records) {
      const row = parseIdentityRecord(raw);
      if (uids.has(row.lifecycleUid)) throw new Error(`duplicate identity UID ${row.lifecycleUid}`);
      const previous = latestByName.get(row.name);
      if (previous && previous.retiredAt === undefined && previous.issuance?.state !== "retired")
        throw new Error(`duplicate active identity record for ${row.name}`);
      uids.add(row.lifecycleUid);
      latestByName.set(row.name, row);
      this.#records.push(row);
    }
  }

  #persist(): void {
    const temp = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const data = `${JSON.stringify({ version: 1, records: this.#records }, null, 2)}\n`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("identity state temporary file is not owned by this user");
      fchmodSync(fd, 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.#path);
      if (process.platform !== "win32") {
        const dirFd = openSync(dirname(this.#path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
  }

  list(): readonly IdentityRecord[] {
    return this.#withLock(() => this.#records.map(cloneRecord));
  }

  get(name: string): IdentityRecord | undefined {
    return this.#withLock(() => {
      const row = this.#current(name);
      return row === undefined ? undefined : cloneRecord(row);
    });
  }

  getByUid(uid: string): IdentityRecord | undefined {
    return this.#withLock(() => {
      const row = this.#records.find((candidate) => candidate.lifecycleUid === uid);
      return row === undefined ? undefined : cloneRecord(row);
    });
  }

  ownsName(name: string, minter: string): boolean {
    return this.#withLock(() => {
      const row = this.#current(name);
      return row !== undefined && row.minter === minter && row.retiredAt === undefined && row.issuance?.state !== "retired";
    });
  }

  put(record: IdentityRecord): void {
    const parsed = parseIdentityRecord(record);
    this.#withLock(() => {
      const index = this.#indexByUid(parsed.lifecycleUid);
      const current = index < 0 ? undefined : this.#records[index];
      if (!current || current.name !== parsed.name || current.minter !== parsed.minter ||
          current.reservedAt !== parsed.reservedAt || this.#current(parsed.name)?.lifecycleUid !== parsed.lifecycleUid)
        throw identityError("conflict", "identity update does not match the current reserved UID");
      if (parsed.publicKey !== current.publicKey || parsed.retiredAt !== current.retiredAt || !sameIssuance(parsed.issuance, current.issuance) || !sameIssuance(parsed.initialIssuance, current.initialIssuance) || JSON.stringify(parsed.renewal) !== JSON.stringify(current.renewal))
        throw identityError("failed-precondition", "identity public-key, retirement, or issuance changes require their atomic store operation");
      if (parsed.touchedAt < current.touchedAt)
        throw identityError("conflict", "identity update is older than the current record");
      if (parsed.touchedAt === current.touchedAt) return;
      this.#records[index] = parsed;
      this.#persist();
    });
  }

  reserve(name: string, minter: string, now = Date.now(), cap = 32): IdentityRecord {
    if (!Number.isSafeInteger(cap) || cap < 1)
      throw identityError("bad-request", "identity reservation cap must be a positive safe integer");
    return this.#withLock(() => {
      const previous = this.#current(name);
      if (previous?.terminalizing && previous.retiredAt === undefined)
        throw identityError("failed-precondition", `identity name ${name} is terminalizing`);
      if (previous && previous.retiredAt === undefined && previous.issuance?.state !== "retired" && previous.minter !== minter)
        throw identityError("already-exists", `identity name ${name} is owned by another minter`);
      if (previous && previous.retiredAt === undefined && previous.issuance?.state !== "retired") {
        const refreshed = { ...previous, touchedAt: Math.max(previous.touchedAt, now) };
        this.#records[this.#indexByUid(previous.lifecycleUid)] = refreshed;
        this.#persist();
        return cloneRecord(refreshed);
      }
      const currentByName = new Map<string, IdentityRecord>();
      for (const row of this.#records) currentByName.set(row.name, row);
      const seats = [...currentByName.values()].filter((row) => row.minter === minter && row.retiredAt === undefined && row.issuance?.state !== "retired").length;
      if (seats >= cap)
        throw new EpEnvelopeError("resource-exhausted", `minter ${minter} has reached its seat mint cap`,
          [{ kind: "ai.cotal.ep.seat-mint-cap", minter, seats, cap }], "not-executed");

      let lifecycleUid = mintLifecycleUid();
      while (this.#indexByUid(lifecycleUid) >= 0) lifecycleUid = mintLifecycleUid();
      const created: IdentityRecord = { version: 1, name, lifecycleUid, minter, reservedAt: now, touchedAt: now };
      this.#records.push(created);
      this.#persist();
      return cloneRecord(created);
    });
  }

  bindPublicKey(name: string, minter: string, lifecycleUid: string, publicKey: string, now = Date.now()): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid)
        throw identityError("conflict", "public-key binding does not match the current lifecycle UID");
      if (current.terminalizing) throw identityError("failed-precondition", "identity is terminalizing");
      if (current.minter !== minter)
        throw identityError("permission-denied", "public-key binding is not owned by this minter");
      if (current.retiredAt !== undefined || current.issuance?.state === "retired")
        throw identityError("failed-precondition", "a retired identity cannot bind a public key");
      if (!USER_NKEY.test(publicKey)) throw identityError("bad-request", "public-key binding is invalid");
      if (current.publicKey !== undefined && current.publicKey !== publicKey)
        throw identityError("already-exists", "identity public key is already bound");
      if (current.publicKey === publicKey) return cloneRecord(current);
      const bound = { ...current, publicKey, touchedAt: Math.max(current.touchedAt, now) };
      this.#records[this.#indexByUid(current.lifecycleUid)] = bound;
      this.#persist();
      return cloneRecord(bound);
    });
  }

  beginRenewal(name: string, minter: string, lifecycleUid: string, expectedIssuanceId: string, renewal: NonNullable<IdentityRecord["renewal"]>): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid || current.minter !== minter || current.terminalizing || current.retiredAt !== undefined || current.issuance?.state !== "issued" || current.issuance.issuanceId !== expectedIssuanceId)
        throw identityError("conflict", "identity changed before renewal");
      if (current.renewal) return cloneRecord(current);
      if (!UID.test(renewal.issuanceId) || !Number.isSafeInteger(renewal.iat) || !Number.isSafeInteger(renewal.exp) || renewal.iat <= current.issuance.iat || renewal.exp <= current.issuance.exp)
        throw identityError("failed-precondition", "renewal must advance the issued credential");
      const updated = { ...current, renewal: { ...renewal } };
      this.#records[this.#indexByUid(lifecycleUid)] = updated;
      this.#persist();
      return cloneRecord(updated);
    });
  }

  finishRenewal(name: string, minter: string, lifecycleUid: string, renewalId: string, credentialId: string): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid || current.minter !== minter || current.retiredAt !== undefined || current.issuance?.state !== "issued" || current.renewal?.issuanceId !== renewalId)
        throw identityError("conflict", "identity renewal changed before completion");
      const { renewal, ...rest } = current;
      const updated = parseIdentityRecord({ ...rest, initialIssuance: current.initialIssuance ?? current.issuance, issuance: { ...current.issuance, ...renewal, credentialId }, touchedAt: Math.max(current.touchedAt, Date.now()) });
      this.#records[this.#indexByUid(lifecycleUid)] = updated;
      this.#persist();
      return cloneRecord(updated);
    });
  }

  transition(
    name: string,
    minter: string,
    lifecycleUid: string,
    expectedGeneration: string | undefined,
    nextIssuance: IdentityIssuance,
    now = Date.now(),
  ): IdentityRecord {
    const next = parseIssuance(nextIssuance);
    if (next === undefined) throw identityError("bad-request", "identity issuance is required");
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid)
        throw identityError("conflict", "issuance transition does not match the current lifecycle UID");
      if (current.minter !== minter)
        throw identityError("permission-denied", "issuance transition is not owned by this minter");
      if (current.issuance?.generation !== expectedGeneration)
        throw identityError("conflict", "identity issuance generation changed before transition");
      if (current.retiredAt !== undefined)
        throw identityError("failed-precondition", "retired identity is terminal");

      const previous = current.issuance;
      if (previous?.state === "retired")
        throw identityError("failed-precondition", "retired issuance is terminal");
      if (!previous) {
        if (expectedGeneration !== undefined || (next.state !== "pending" && next.state !== "issued"))
          throw identityError("failed-precondition", "initial identity issuance must be pending or issued");
      } else if (next.generation === previous.generation) {
        const sameAuthority = next.iat === previous.iat && next.exp === previous.exp &&
          next.acceptedToken === previous.acceptedToken && next.issuanceId === previous.issuanceId &&
          (previous.credentialId === next.credentialId || (previous.state === "pending" && next.state === "issued" && previous.credentialId === undefined && next.credentialId !== undefined));
        const allowed = next.state === previous.state ||
          (previous.state === "pending" && next.state === "issued") ||
          (previous.state === "issued" && next.state === "retiring") ||
          (previous.state === "retiring" && next.state === "retired");
        if (!sameAuthority || !allowed)
          throw identityError("failed-precondition", "identity issuance transition is not allowed");
      } else if (previous.state !== "issued" || next.state !== "issued") {
        throw identityError("failed-precondition", "a renewed issuance must replace an issued generation");
      }

      const updated: IdentityRecord = {
        ...current,
        issuance: next,
        ...(next.state === "retired" ? { retiredAt: now } : {}),
        touchedAt: Math.max(current.touchedAt, now),
      };
      this.#records[this.#indexByUid(current.lifecycleUid)] = updated;
      this.#persist();
      return cloneRecord(updated);
    });
  }

  latchRetirement(name: string, minter: string, lifecycleUid: string): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid || current.minter !== minter) throw identityError("conflict", "identity retirement does not match the reservation");
      if (current.retiredAt !== undefined || current.terminalizing) return cloneRecord(current);
      const updated = { ...current, terminalizing: true as const };
      this.#records[this.#indexByUid(lifecycleUid)] = updated;
      this.#persist();
      return cloneRecord(updated);
    });
  }

  recordRetirementExpiry(name: string, minter: string, lifecycleUid: string): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid || current.minter !== minter || !current.terminalizing)
        throw identityError("conflict", "identity retirement latch changed");
      const expiry = Math.max(current.issuance?.exp ?? 0, current.renewal?.exp ?? 0, current.retirementExpiry ?? 0);
      const updated = { ...current, retirementExpiry: expiry };
      this.#records[this.#indexByUid(lifecycleUid)] = updated;
      this.#persist();
      return cloneRecord(updated);
    });
  }

  retire(name: string, minter: string, lifecycleUid: string, expectedGeneration: string | undefined, now = Date.now()): IdentityRecord {
    return this.#withLock(() => {
      const current = this.#current(name);
      if (!current || current.lifecycleUid !== lifecycleUid)
        throw identityError("conflict", "retirement does not match the current lifecycle UID");
      if (current.minter !== minter)
        throw identityError("permission-denied", "retirement is not owned by this minter");
      if (current.issuance?.generation !== expectedGeneration)
        throw identityError("conflict", "identity issuance generation changed before retirement");
      if (current.retiredAt !== undefined) return cloneRecord(current);
      const { renewal: _renewal, ...settled } = current;
      const retired: IdentityRecord = {
        ...settled,
        retiredAt: now,
        ...(current.issuance === undefined ? {} : { issuance: { ...current.issuance, state: "retired" } }),
        touchedAt: Math.max(current.touchedAt, now),
      };
      this.#records[this.#indexByUid(current.lifecycleUid)] = retired;
      this.#persist();
      return cloneRecord(retired);
    });
  }
}

function recordName(name: string): string {
  return Buffer.from(name, "utf8").toString("hex");
}


export function identityRecordFileName(name: string): string { return recordName(name); }
