import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLockAsync, canonicalJson, mkSecretDir, openPrivateAppend } from "@cotal-ai/core";
import type { EnrollPlacementRequest, EnrollPlacementResult } from "@cotal-ai/core";

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

export type PlacementEnrollmentRequest = EnrollPlacementRequest;
type JournalLine =
  | { readonly v: 1; readonly kind: "pending"; readonly enrollmentOperationId: string; readonly requestDigest: string }
  | { readonly v: 1; readonly kind: "complete"; readonly enrollmentOperationId: string; readonly requestDigest: string; readonly result: EnrollPlacementResult };

type OperationState = { readonly requestDigest: string; readonly result?: EnrollPlacementResult };

/** Fsynced, append-only operation results. The stable operation id is the only replay key. */
export class PlacementEnrollmentStore {
  readonly path: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    mkSecretDir(dir);
    this.path = join(dir, "placement-enrollment.journal.ndjson");
    this.lockPath = `${this.path}.lock`;
  }

  /** Return the exact prior result, or reserve and durably record the produced result before returning it. */
  async execute(request: PlacementEnrollmentRequest, enroll: () => Promise<EnrollPlacementResult>): Promise<EnrollPlacementResult> {
    validateRequest(request);
    const digest = digestRequest(request);
    const lock = await acquireLockAsync(this.lockPath, { label: "placement enrollment operation" });
    try {
      const records = this.loadLocked();
      const prior = records.get(request.enrollmentOperationId);
      if (prior) {
        if (!safeEqual(prior.requestDigest, digest)) throw new Error("placement enrollment operation id was replayed with changed authority");
        if (prior.result === undefined) throw new Error("placement enrollment operation has an unresolved durable reservation; refusing to create another enrollment");
        return prior.result;
      }
      this.appendLocked({ v: VERSION, kind: "pending", enrollmentOperationId: request.enrollmentOperationId, requestDigest: digest });
      const result = await enroll();
      validateResult(result, request);
      this.appendLocked({ v: VERSION, kind: "complete", enrollmentOperationId: request.enrollmentOperationId, requestDigest: digest, result });
      return result;
    } finally {
      lock.release();
    }
  }

  /** A read-only exact replay lookup used by verification; missing or unresolved records refuse. */
  async lookup(enrollmentOperationId: string): Promise<EnrollPlacementResult | undefined> {
    if (!UUID.test(enrollmentOperationId)) throw new Error("placement enrollment operation id is malformed");
    const lock = await acquireLockAsync(this.lockPath, { label: "placement enrollment operation" });
    try {
      const result = this.loadLocked().get(enrollmentOperationId);
      if (result && result.result === undefined) throw new Error("placement enrollment operation has an unresolved durable reservation");
      return result?.result;
    } finally { lock.release(); }
  }


  private loadLocked(): Map<string, OperationState> {
    if (!existsSync(this.path)) return new Map();
    let fd: number | undefined;
    let data: Buffer;
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error("journal is a symlink");
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("journal is not a regular file");
      if (process.getuid && stat.uid !== process.getuid()) throw new Error("journal is not owned by this user");
      fchmodSync(fd, 0o600);
      data = readFileSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const complete = data.lastIndexOf(0x0a) + 1;
    if (complete !== data.length) this.recoverTornTail(data.subarray(0, complete));
    const records = new Map<string, OperationState>();
    const text = data.subarray(0, complete).toString("utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; }
      catch { throw new Error(`placement enrollment journal has invalid JSON at line ${index + 1}`); }
      const record = parseJournalLine(raw, index + 1);
      const prior = records.get(record.enrollmentOperationId);
      if (record.kind === "pending") {
        if (prior !== undefined) throw new Error(`placement enrollment journal repeats operation reservation at line ${index + 1}`);
        records.set(record.enrollmentOperationId, { requestDigest: record.requestDigest });
      } else {
        if (prior === undefined || prior.result !== undefined || !safeEqual(prior.requestDigest, record.requestDigest))
          throw new Error(`placement enrollment journal has an invalid completion at line ${index + 1}`);
        records.set(record.enrollmentOperationId, { requestDigest: prior.requestDigest, result: record.result });
      }
    }
    return records;
  }

  private recoverTornTail(completeData: Buffer): void {
    const tmp = `${this.path}.${process.pid}.${Date.now()}.repair`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, completeData); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(tmp, this.path);
      fsyncDirectory(dirname(this.path));
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* retain the primary repair failure */ }
      throw error;
    }
  }

  private appendLocked(record: JournalLine): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openPrivateAppend(this.path);
    try {
      appendFileSync(fd, `${canonicalJson(record)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDirectory(directory);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function validateRequest(request: PlacementEnrollmentRequest): void {
  if (!UUID.test(request.acceptanceId) || !UUID.test(request.enrollmentOperationId) || !DIGEST.test(request.actorTokenHash))
    throw new Error("placement enrollment request has malformed acceptance, operation, or token digest");
}

function digestRequest(request: PlacementEnrollmentRequest): string {
  return createHash("sha256").update(canonicalJson({ acceptanceId: request.acceptanceId, enrollmentOperationId: request.enrollmentOperationId,
    authority: request.authority, actorTokenHash: request.actorTokenHash })).digest("hex");
}

function validateResult(result: EnrollPlacementResult, request: PlacementEnrollmentRequest): void {
  const authority = request.authority;
  if (authority.subject.phase !== "accepted" || authority.subject.acceptanceId !== request.acceptanceId ||
      authority.subject.enrollmentOperationId !== request.enrollmentOperationId ||
      result.identity.acceptanceId !== request.acceptanceId || result.identity.enrollmentOperationId !== request.enrollmentOperationId ||
      result.identity.intentDigest !== authority.intentDigest || !UUID.test(result.identity.enrollmentRef) ||
      !Number.isSafeInteger(result.identity.target.generation) || result.identity.target.generation < 1 || result.identity.target.lifecycle.space !== "main")
    throw new Error("placement enrollment result identity does not match its accepted operation");
  canonicalJson(result);
}



function parseJournalLine(raw: unknown, line: number): JournalLine {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`placement enrollment journal has malformed record at line ${line}`);
  const o = raw as Record<string, unknown>;
  if (o.v !== VERSION || (o.kind !== "pending" && o.kind !== "complete") || typeof o.enrollmentOperationId !== "string" || !UUID.test(o.enrollmentOperationId) ||
      typeof o.requestDigest !== "string" || !DIGEST.test(o.requestDigest))
    throw new Error(`placement enrollment journal has malformed record at line ${line}`);
  const expectedKeys = o.kind === "pending" ? "enrollmentOperationId,kind,requestDigest,v" : "enrollmentOperationId,kind,requestDigest,result,v";
  if (Object.keys(o).sort().join(",") !== expectedKeys) throw new Error(`placement enrollment journal has unknown fields at line ${line}`);
  if (o.kind === "pending") return raw as JournalLine;
  const result = o.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error(`placement enrollment journal has malformed result at line ${line}`);
  const identity = (result as Record<string, unknown>).identity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) throw new Error(`placement enrollment journal has malformed identity at line ${line}`);
  const identityRow = identity as Record<string, unknown>;
  if (identityRow.enrollmentOperationId !== o.enrollmentOperationId || typeof identityRow.acceptanceId !== "string" || !UUID.test(identityRow.acceptanceId) ||
      typeof identityRow.intentDigest !== "string" || !DIGEST.test(identityRow.intentDigest.replace(/^sha256:/, "")) || typeof identityRow.enrollmentRef !== "string")
    throw new Error(`placement enrollment journal result identity mismatch at line ${line}`);
  canonicalJson(result);
  return raw as JournalLine;

}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
