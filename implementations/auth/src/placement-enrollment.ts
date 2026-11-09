import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLockAsync, canonicalJson, contractDigest, EpEnvelopeError, isContractDigest, mkSecretDir, parsePlacementEnrollmentRequest, parsePlacementEnrollmentVerificationRequest, type AcceptedIntent, type EnrollmentIdentity, type ExecutionAuthority, type ExecutionEffect, type PlacementEnrollmentRequest, type PlacementEnrollmentResult, type RemoteManagedAgentEnrollmentResult } from "@cotal-ai/core";
import { findInteractiveActor, findManagedActor, assertWithinSpawnerGrant, withManagedGrantTransaction } from "./ledger.js";
import { authorizeRemoteManagedAgentEnrollment, type ObserveManagerGate } from "./managed-agent-enrollment.js";
import type { ReconcilerPort, ServiceAuthenticator } from "@cotal-ai/core";

export interface PlacementEnrollmentAuthorityOptions {
  dir: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
  reconciler?: ReconcilerPort;
  authenticator?: ServiceAuthenticator;
  enrollManagedAgent(args: {
    owner: string;
    scope: string[];
    request: PlacementEnrollmentRequest["enrollment"];
    replayLifecycleUid?: string;
    sentinelCreds: string;
    agentBearerExchangeUrl: string;
  }): Promise<RemoteManagedAgentEnrollmentResult>;
  assertOpen(): void;
}

export interface PlacementEnrollmentAuthority {
  enrollPlacement(args: { owner: string; scope: string[]; request: unknown; sentinelCreds: string; agentBearerExchangeUrl: string; onDelivered: (release: () => void) => void }): Promise<PlacementEnrollmentResult>;
  verifyPlacementEnrollment(args: { caller: string; request: unknown }): Promise<{ identity: EnrollmentIdentity; active: true }>;
  enrollmentEffectStatus(args: { caller: string; effectId: string }): Promise<{ effectId: string; state: "effective" | "unknown" | "cancelled" | "pending"; enrollment?: EnrollmentIdentity; noLateEffects: boolean; privateCustody: "none" }>;
  closeEnrollmentEffect(args: { caller: string; effectId: string; fenceId: string }): Promise<{ effectId: string; state: "effective" | "unknown" | "cancelled" | "pending"; enrollment?: EnrollmentIdentity; noLateEffects: boolean; privateCustody: "none" }>;
  retirePlacementEnrollment(args: { caller: string; operationId: string; identity: EnrollmentIdentity; fenceId: string }): Promise<{ state: "retired" | "unknown"; denialProofId?: string }>;
}

interface PendingRecord {
  v: 1;
  state: "pending";
  requestDigest: string;
  acceptanceId: string;
  owner: string;
  effectId: string;
  enrollmentOperationId: string;
  actorTokenHash: string;
  authority: ExecutionAuthority;
  placement: AcceptedIntent["intent"]["placement"];
}

interface CompleteRecord extends Omit<PendingRecord, "state"> {
  state: "complete";
  identity: EnrollmentIdentity;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: "bad-request" | "permission-denied" | "failed-precondition" | "conflict" | "unavailable" | "unimplemented", message: string, outcome?: "not-executed" | "executed" | "unknown"): never => {
  throw new EpEnvelopeError(code, message, undefined, outcome);
};

function journalDirectory(dir: string): string {
  const directory = join(dir, "placement-enrollments");
  mkSecretDir(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    fail("unavailable", "placement enrollment journal is not owner-private");
  return directory;
}

function durableCreate(directory: string, name: string, value: unknown): void {
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, canonicalJson(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function readRecord<T>(directory: string, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    fail("unavailable", `placement enrollment journal ${name} is unreadable`);
  }
}

function businessDigest(request: PlacementEnrollmentRequest): string {
  const enrollment = request.enrollment;
  return contractDigest({
    acceptanceId: request.acceptanceId,
    enrollmentOperationId: request.enrollmentOperationId,
    placementOperationId: request.authority.placementOperationId,
    intentDigest: request.authority.intentDigest,
    actorTokenHash: request.actorTokenHash,
    enrollment: {
      space: enrollment.space,
      actor: enrollment.actor,
      instanceId: enrollment.instanceId,
      target: enrollment.target,
      spawn: enrollment.spawn ?? null,
      identities: enrollment.identities,
    },
  });
}

function sameAuthority(a: ExecutionAuthority, b: ExecutionAuthority): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function parseAccepted(raw: unknown, authority: ExecutionAuthority): AcceptedIntent {
  if (!isObject(raw) || !isObject(raw.intent) || !isObject(raw.intent.placement) || !isObject(raw.executionGate) || !isObject(raw.executionGate.authority))
    fail("unavailable", "reconciler accepted-intent answer is malformed", "unknown");
  const accepted = raw as unknown as AcceptedIntent;
  const { digest, ...intent } = accepted.intent;
  if (!UUID.test(accepted.acceptanceId) || !UUID.test(accepted.enrollmentOperationId) ||
      !uint(accepted.acceptedListRevision) || !uint(accepted.acceptedSeatRevision) ||
      accepted.acceptanceId !== authority.subject.acceptanceId || accepted.enrollmentOperationId !== authority.subject.enrollmentOperationId ||
      !isContractDigest(digest) || digest !== authority.intentDigest || contractDigest(intent) !== digest ||
      accepted.intent.placement.space !== "main" || accepted.intent.placement.name.length === 0 ||
      accepted.intent.placement.operationId !== authority.placementOperationId ||
      accepted.intent.placement.generation < 0 || !Number.isSafeInteger(accepted.intent.placement.generation) ||
      accepted.intent.placement.claim.instanceId !== authority.claim.instanceId ||
      canonicalJson(accepted.intent.placement.claim) !== canonicalJson(authority.claim) ||
      accepted.executionGate.state !== "open" || !sameAuthority(accepted.executionGate.authority, authority))
    fail("permission-denied", "reconciler accepted intent does not match the current enrollment authority", "not-executed");
  return accepted;
}

function parseEffect(raw: unknown, authority: ExecutionAuthority, accepted: AcceptedIntent): ExecutionEffect {
  if (!isObject(raw) || !isObject(raw.authority)) fail("unavailable", "reconciler enrollment effect is malformed", "unknown");
  const effect = raw as unknown as ExecutionEffect;
  if (!UUID.test(effect.effectId) || effect.kind !== "enroll" || effect.state !== "admitted" ||
      effect.operationId !== accepted.enrollmentOperationId || !sameAuthority(effect.authority, authority))
    fail("failed-precondition", "reconciler enrollment effect is not admitted for this authority", "not-executed");
  return effect;
}

function parseStoredRecord(raw: unknown, request: PlacementEnrollmentRequest, digest: string): PendingRecord | CompleteRecord {
  if (!isObject(raw) || raw.v !== 1 || (raw.state !== "pending" && raw.state !== "complete") ||
      raw.requestDigest !== digest || raw.acceptanceId !== request.acceptanceId ||
      raw.enrollmentOperationId !== request.enrollmentOperationId || raw.actorTokenHash !== request.actorTokenHash ||
      typeof raw.effectId !== "string" || !UUID.test(raw.effectId) || typeof raw.owner !== "string" ||
      !isObject(raw.authority) || !isObject(raw.placement))
    fail("conflict", "placement enrollment replay differs from its durable operation payload", "not-executed");
  const record = raw as unknown as PendingRecord | CompleteRecord;
  if (!sameAuthority(record.authority, request.authority)) {
    const savedClaim = record.authority.claim;
    const currentClaim = request.authority.claim;
    if (savedClaim.instanceId !== currentClaim.instanceId || savedClaim.managerLifecycleUid !== currentClaim.managerLifecycleUid ||
        savedClaim.accountPublicKey !== currentClaim.accountPublicKey || savedClaim.assignmentRevision !== currentClaim.assignmentRevision)
      fail("permission-denied", "placement enrollment replay has a different manager assignment", "not-executed");
  }
  if (record.state === "complete") {
    const identity = record.identity;
    if (!isObject(identity) || identity.acceptanceId !== request.acceptanceId || identity.enrollmentOperationId !== request.enrollmentOperationId)
      fail("unavailable", "placement enrollment journal identity is corrupt");
  }
  return record;
}

function identityFor(record: PendingRecord, owner: string, lifecycleUid: string): EnrollmentIdentity {
  return {
    acceptanceId: record.acceptanceId,
    enrollmentOperationId: record.enrollmentOperationId,
    enrollmentRef: `${record.acceptanceId}/${record.enrollmentOperationId}`,
    target: {
      seatName: record.placement.name,
      lifecycle: { space: record.placement.space, owner, actor: record.placement.name, lifecycleUid },
      generation: record.placement.generation,
    },
    intentDigest: record.authority.intentDigest,
  };
}

function assertHeldRow(options: PlacementEnrollmentAuthorityOptions, owner: string, actor: string, tokenHash: string, instanceId: string, lifecycleUid?: string): string | undefined {
  const row = findManagedActor(options.dir, owner, actor);
  if (!row) return undefined;
  if (row.tokenHash !== tokenHash || row.custody?.kind !== "remote-manager" || row.custody.instanceId !== instanceId ||
      (lifecycleUid !== undefined && row.lifecycleUid !== lifecycleUid))
    fail("conflict", `managed agent ${owner}/${actor} is not the recorded placement enrollment`, "not-executed");
  if (row.lifecycleUid === undefined) fail("unavailable", "managed placement grant has no lifecycle uid");
  assertWithinSpawnerGrant(options.dir, row, "spawn");
  return row.lifecycleUid;
}

async function managerEnrollment(options: PlacementEnrollmentAuthorityOptions, owner: string, scope: string[], request: PlacementEnrollmentRequest, sentinelCreds: string, agentBearerExchangeUrl: string, replayLifecycleUid?: string): Promise<RemoteManagedAgentEnrollmentResult> {
  return options.enrollManagedAgent({ owner, scope, request: request.enrollment, sentinelCreds, agentBearerExchangeUrl, ...(replayLifecycleUid !== undefined ? { replayLifecycleUid } : {}) });
}

function verifyMaterial(result: RemoteManagedAgentEnrollmentResult, request: PlacementEnrollmentRequest, owner: string): string {
  if (result.v !== 1 || result.kind !== "manager-managed-agent-enrollment" || result.space !== request.enrollment.space ||
      result.owner !== owner || result.actor !== request.enrollment.actor || result.instanceId !== request.enrollment.instanceId ||
      result.managerLifecycleUid !== request.enrollment.managerLifecycleUid || result.requestId !== request.enrollment.requestId ||
      result.serveEpoch !== request.enrollment.serveEpoch || result.material.owner !== owner ||
      result.material.actor !== request.enrollment.target.actor || !/^[a-z0-9]{26,32}$/.test(result.material.lifecycleUid))
    fail("unavailable", "managed enrollment returned material for another placement", "unknown");
  return result.material.lifecycleUid;
}

export function createPlacementEnrollmentAuthority(options: PlacementEnrollmentAuthorityOptions) {
  const directory = journalDirectory(options.dir);

  const enrollPlacement = async (args: { owner: string; scope: string[]; request: unknown; sentinelCreds: string; agentBearerExchangeUrl: string; onDelivered: (release: () => void) => void }): Promise<PlacementEnrollmentResult> => {
    options.assertOpen();
    const request = parsePlacementEnrollmentRequest(args.request);
    if (request.enrollment.space !== options.space || request.authority.claim.accountPublicKey !== options.accountPublicKey)
      fail("permission-denied", "placement enrollment names another host space or account", "not-executed");
    const gate = await options.observeManagerGate(request.enrollment.instanceId);
    const authorized = await authorizeRemoteManagedAgentEnrollment({
      request: request.enrollment,
      space: options.space,
      owner: args.owner,
      scope: args.scope,
      proofSecret: options.proofSecret,
      observeManagerGate: async () => gate,
    });
    if (gate?.registrationRevision !== request.authority.claim.currentRegistrationRevision || gate.processEpoch !== request.authority.claim.serveEpoch)
      fail("permission-denied", "placement enrollment claim does not match current manager registration", "not-executed");

    const digest = businessDigest(request);
    const held = await acquireLockAsync(join(directory, `${request.enrollmentOperationId}.lock`), { label: "placement enrollment", waitMs: 30_000 });
    let effectLease: { release(): void } | undefined;
    let deliveryOwnsLease = false;
    try {
      options.assertOpen();
      const pendingName = `${request.enrollmentOperationId}.pending.json`;
      const completeName = `${request.enrollmentOperationId}.complete.json`;
      let pending = readRecord<unknown>(directory, pendingName);
      let complete = readRecord<unknown>(directory, completeName);
      if (complete !== undefined || pending !== undefined) {
        const stored = parseStoredRecord(complete ?? pending, request, digest);
        if (stored.owner !== args.owner) fail("permission-denied", "placement enrollment belongs to another owner", "not-executed");
        effectLease = await acquireLockAsync(join(directory, `${stored.effectId}.effect.lock`), { label: "enrollment effect" });
        if (readRecord<unknown>(directory, `${stored.effectId}.closed.json`) !== undefined)
          fail("failed-precondition", "placement enrollment effect is closed", "not-executed");
        const lifecycleUid = assertHeldRow(options, args.owner, authorized.target.actor, request.actorTokenHash, request.authority.claim.instanceId,
          stored.state === "complete" ? stored.identity.target.lifecycle.lifecycleUid : undefined);
        if (lifecycleUid === undefined) throw new EpEnvelopeError("unavailable", "placement enrollment outcome is unknown; the recorded grant is absent", undefined, "unknown");
        const result = await managerEnrollment(options, args.owner, args.scope, request, args.sentinelCreds, args.agentBearerExchangeUrl, lifecycleUid);
        verifyMaterial(result, request, args.owner);
        if (stored.state === "pending") {
          const identity = identityFor(stored, args.owner, lifecycleUid);
          durableCreate(directory, completeName, { ...stored, state: "complete", identity });
          complete = { ...stored, state: "complete", identity };
        }
        const identity = (complete as CompleteRecord).identity;
        if (identity.target.lifecycle.lifecycleUid !== lifecycleUid)
          fail("conflict", "placement enrollment lifecycle changed during replay", "not-executed");
        args.onDelivered(effectLease.release);
        deliveryOwnsLease = true;
        return { identity, material: result.material };
      }
      if (findManagedActor(options.dir, args.owner, authorized.target.actor) || findInteractiveActor(options.dir, args.owner, authorized.target.actor))
        fail("conflict", `managed agent ${args.owner}/${authorized.target.actor} is already held outside this placement operation`, "not-executed");
      if (!options.reconciler) throw new EpEnvelopeError("unimplemented", "reconciler accepted-intent port is not configured");
      options.assertOpen();
      const admission = await options.reconciler.acceptedIntent({
        acceptanceId: request.acceptanceId,
        authority: request.authority,
        actorTokenHash: request.actorTokenHash,
      });
      const accepted = parseAccepted(admission.accepted, request.authority);
      if (accepted.intent.placement.space !== request.enrollment.space || accepted.intent.placement.name !== authorized.target.actor)
        fail("permission-denied", "enrollment target differs from the accepted placement", "not-executed");
      const effect = parseEffect(admission.effect, request.authority, accepted);
      effectLease = await acquireLockAsync(join(directory, `${effect.effectId}.effect.lock`), { label: "enrollment effect" });
      if (readRecord<unknown>(directory, `${effect.effectId}.closed.json`) !== undefined)
        fail("failed-precondition", "placement enrollment effect is closed", "not-executed");
      options.assertOpen();
      const record: PendingRecord = {
        v: 1,
        state: "pending",
        requestDigest: digest,
        effectId: effect.effectId,
        owner: args.owner,
        acceptanceId: request.acceptanceId,
        enrollmentOperationId: request.enrollmentOperationId,
        actorTokenHash: request.actorTokenHash,
        authority: request.authority,
        placement: accepted.intent.placement,
      };
      durableCreate(directory, pendingName, record);
      options.assertOpen();
      const result = await managerEnrollment(options, args.owner, args.scope, request, args.sentinelCreds, args.agentBearerExchangeUrl);
      const lifecycleUid = verifyMaterial(result, request, args.owner);
      const identity = identityFor(record, args.owner, lifecycleUid);
      durableCreate(directory, completeName, { ...record, state: "complete", identity });
      options.assertOpen();
      args.onDelivered(effectLease.release);
      deliveryOwnsLease = true;
      return { identity, material: result.material };
    } finally {
      if (!deliveryOwnsLease) effectLease?.release();
      held.release();
    }
  };

  const authenticate = async (caller: string) => {
    if (!options.authenticator) throw new EpEnvelopeError("unimplemented", "service-authentication port is not configured");
    if ((await options.authenticator.authenticateService(caller)).principal !== "reconciler")
      fail("permission-denied", "enrollment participant requires the reconciler service", "not-executed");
  };
  const enrollmentEffectStatus = async ({ caller, effectId }: { caller: string; effectId: string }) => {
    await authenticate(caller);
    if (!UUID.test(effectId)) fail("bad-request", "invalid effect id");
    const lease = await acquireLockAsync(join(directory, `${effectId}.effect.lock`), { label: "enrollment effect" });
    try {
    let complete: CompleteRecord | undefined;
    let pending: PendingRecord | undefined;
    for (const name of readdirSync(directory)) {
      if (name.endsWith(".complete.json")) {
        const record = readRecord<CompleteRecord>(directory, name);
        if (record?.effectId === effectId) complete = record;
      } else if (name.endsWith(".pending.json")) {
        const record = readRecord<PendingRecord>(directory, name);
        if (record?.effectId === effectId) pending = record;
      }
    }
    if (!complete && pending) {
      const uid = assertHeldRow(options, pending.owner, pending.placement.name, pending.actorTokenHash, pending.authority.claim.instanceId);
      if (uid) {
        complete = { ...pending, state: "complete", identity: identityFor(pending, pending.owner, uid) };
        durableCreate(directory, `${pending.enrollmentOperationId}.complete.json`, complete);
      }
    }
    const closed = readRecord<unknown>(directory, `${effectId}.closed.json`) !== undefined;
    return { effectId, state: complete ? "effective" as const : pending ? "unknown" as const : closed ? "cancelled" as const : "pending" as const,
      ...(complete ? { enrollment: complete.identity } : {}), noLateEffects: closed && (!pending || !!complete), privateCustody: "none" as const };
    } finally { lease.release(); }
  };
  const closeEnrollmentEffect = async ({ caller, effectId, fenceId }: { caller: string; effectId: string; fenceId: string }) => {
    await authenticate(caller);
    if (!UUID.test(effectId) || !UUID.test(fenceId)) fail("bad-request", "invalid effect or fence id");
    const lease = await acquireLockAsync(join(directory, `${effectId}.effect.lock`), { label: "enrollment effect" });
    try {
      const name = `${effectId}.closed.json`;
      const existing = readRecord<unknown>(directory, name);
      if (existing === undefined) durableCreate(directory, name, { effectId, fenceId });
      else if (!isObject(existing) || existing.fenceId !== fenceId || existing.effectId !== effectId)
        fail("conflict", "enrollment effect was closed by another fence");
    } finally { lease.release(); }
    return enrollmentEffectStatus({ caller, effectId });
  };
  const retirePlacementEnrollment = async ({ caller, operationId, identity, fenceId }: { caller: string; operationId: string; identity: EnrollmentIdentity; fenceId: string }) => {
    await authenticate(caller);
    if (!UUID.test(operationId) || !UUID.test(fenceId)) fail("bad-request", "invalid retirement operation or fence id");
    const lock = await acquireLockAsync(join(directory, `${operationId}.retire.lock`), { label: "enrollment retirement" });
    try {
      const pendingName = `${operationId}.retirement-pending.json`;
      const pending = readRecord<{ identity: EnrollmentIdentity; fenceId: string }>(directory, pendingName);
      if (pending && (pending.fenceId !== fenceId || canonicalJson(pending.identity) !== canonicalJson(identity)))
        fail("conflict", "retirement tuple changed");
      const name = `${operationId}.retirement.json`;
      const existing = readRecord<{ identity: EnrollmentIdentity; fenceId: string; denialProofId: string }>(directory, name);
      if (existing) {
        if (existing.fenceId !== fenceId || canonicalJson(existing.identity) !== canonicalJson(identity)) fail("conflict", "retirement tuple changed");
        return { state: "retired" as const, denialProofId: existing.denialProofId };
      }
      const record = readRecord<CompleteRecord>(directory, `${identity.enrollmentOperationId}.complete.json`);
      if (!record || canonicalJson(record.identity) !== canonicalJson(identity)) throw new EpEnvelopeError("permission-denied", "unknown enrollment identity");
      const closed = readRecord<{ fenceId: string }>(directory, `${record.effectId}.closed.json`);
      if (!closed || closed.fenceId !== fenceId) fail("failed-precondition", "enrollment effect is not closed by this fence");
      if (!pending) durableCreate(directory, pendingName, { identity, fenceId });
      const target = identity.target.lifecycle;
      const custody = { kind: "remote-manager" as const, instanceId: record.authority.claim.instanceId };
      const gone = withManagedGrantTransaction(options.dir, (tx) => {
        const row = tx.read(target.owner, target.actor);
        if (row && (row.kind !== "managed-agent" || row.lifecycleUid !== target.lifecycleUid || row.tokenHash !== record.actorTokenHash)) return false;
        if (row) tx.revokeManagedIf(target.owner, target.actor, { lifecycleUid: target.lifecycleUid, custody });
        const after = tx.read(target.owner, target.actor);
        return !after || after.lifecycleUid !== target.lifecycleUid;
      });
      if (!gone) return { state: "unknown" as const };
      const denialProofId = randomUUID();
      durableCreate(directory, name, { identity, fenceId, denialProofId });
      return { state: "retired" as const, denialProofId };
    } finally { lock.release(); }
  };

  const verifyPlacementEnrollment = async (args: { caller: string; request: unknown }): Promise<{ identity: EnrollmentIdentity; active: true }> => {
    options.assertOpen();
    await authenticate(args.caller);
    const request = parsePlacementEnrollmentVerificationRequest(args.request);
    const { identity, claim } = request;
    if (identity.target.lifecycle.space !== options.space || claim.accountPublicKey !== options.accountPublicKey)
      fail("permission-denied", "placement enrollment verification names another space or account", "not-executed");
    const complete = readRecord<unknown>(directory, `${identity.enrollmentOperationId}.complete.json`);
    if (complete === undefined) fail("failed-precondition", "placement enrollment is not durably committed", "not-executed");
    if (!isObject(complete) || complete.state !== "complete" || !isObject(complete.identity) ||
        canonicalJson(complete.identity) !== canonicalJson(identity) || complete.enrollmentOperationId !== identity.enrollmentOperationId)
      fail("permission-denied", "placement enrollment identity differs from the durable record", "not-executed");
    const gate = await options.observeManagerGate(claim.instanceId);
    if (!gate || gate.state !== "open" || gate.principal !== `${identity.target.lifecycle.owner}.manager_serve_${claim.instanceId}` ||
        gate.processEpoch !== claim.serveEpoch || gate.registrationRevision !== claim.currentRegistrationRevision)
      fail("permission-denied", "placement enrollment verification claim is not the current open manager registration", "not-executed");
    const record = complete as unknown as CompleteRecord;
    if (record.authority.claim.instanceId !== claim.instanceId || record.authority.claim.managerLifecycleUid !== claim.managerLifecycleUid ||
        record.authority.claim.assignmentRevision !== claim.assignmentRevision)
      fail("permission-denied", "placement enrollment claim differs from its recorded assignment", "not-executed");
    const lifecycleUid = assertHeldRow(options, identity.target.lifecycle.owner, identity.target.lifecycle.actor,
      record.actorTokenHash, claim.instanceId, identity.target.lifecycle.lifecycleUid);
    if (lifecycleUid === undefined) fail("failed-precondition", "placement enrollment is no longer active", "not-executed");
    return { identity, active: true };
  };

  return { enrollPlacement, verifyPlacementEnrollment, enrollmentEffectStatus, closeEnrollmentEffect, retirePlacementEnrollment };
}

export type { ReconcilerPort, ServiceAuthenticator } from "@cotal-ai/core";
