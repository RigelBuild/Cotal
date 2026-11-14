import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLockAsync, assertLifecycleToken, canonicalJson, contractDigest, EpEnvelopeError, isContractDigest, mkSecretDir, remoteManagerServePrincipal, type PlacementEnrollmentRequest, type PlacementEnrollmentResult, type RemoteManagedAgentEnrollmentResult } from "@cotal-ai/core";
import { findInteractiveActor, findManagedActor, assertWithinSpawnerGrant, withManagedGrantTransaction } from "./ledger.js";
import { authorizeRemoteManagedAgentEnrollment, type ObserveManagerGate } from "./managed-agent-enrollment.js";
import { parsePlacementEnrollmentRequest, resolveReadAcl } from "@cotal-ai/core";
import { parsePlacementEnrollmentVerificationRequest } from "./placement-enrollment-types.js";
export interface ManagerClaimView {
  accountPublicKey: string;
  instanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  currentRegistrationRevision: number;
  serveEpoch: number;
}

export interface AcceptedPlacementView {
  space: "main";
  name: string;
  desiredRevision: number;
  seatRevision: number;
  claim: ManagerClaimView;
  generation: number;
  operationId: string;
  workspace: string;
}

export interface PlacementAuthorityView {
  subject: { acceptanceId: string; enrollmentOperationId: string; phase: "accepted" };
  placementOperationId: string;
  intentDigest: string;
  claim: ManagerClaimView;
  launchRevision: number;
}

export interface AcceptedIntentView {
  acceptanceId: string;
  intent: { digest: string; placement: AcceptedPlacementView; role: string; roleTreeRevision: number; [field: string]: unknown };
  acceptedListRevision: number;
  acceptedSeatRevision: number;
  enrollmentOperationId: string;
  executionGate: { authority: PlacementAuthorityView; state: "open" | "closing" | "closed"; fenceId?: string };
}

export interface EnrollmentIdentity {
  acceptanceId: string;
  enrollmentOperationId: string;
  enrollmentRef: string;
  target: { seatName: string; lifecycle: { space: string; owner: string; actor: string; lifecycleUid: string }; generation: number };
  intentDigest: string;
}

export interface PlacementEnrollmentVerificationRequest { identity: EnrollmentIdentity; claim: ManagerClaimView; }

export interface EnrollEffectView {
  effectId: string;
  authority: PlacementAuthorityView;
  operationId: string;
  kind: "enroll" | "bind" | "create" | "bootstrap";
  state: "admitted" | "unknown" | "cancelled" | "effective";
  enrollment?: EnrollmentIdentity;
  stageId?: string;
  execution?: unknown;
}

export interface ReconcilerPort {
  acceptedIntent(request: { acceptanceId: string; authority: PlacementAuthorityView; actorTokenHash: string }): Promise<{ accepted: AcceptedIntentView; effect: EnrollEffectView }>;
}

/** Maps the broker-authenticated caller to a service principal. `transportPrincipal` is the caller's
 *  broker-authenticated `owner.actor` key (`principalKey(owner, actor).key`), never a body field. An
 *  implementation MUST compare it exactly against the configured reconciler identity: never by actor
 *  name alone, never by suffix, since a match on the actor name would admit any owner's `reconciler`. */
export interface ServiceAuthenticator {
  authenticateService(request: { transportPrincipal: string; operation: string; requestDigest: string }): Promise<{ principal: string }>;
}

export type EnrollmentAcl = Pick<PlacementEnrollmentRequest["enrollment"]["target"], "subscribe" | "allowSubscribe" | "allowPublish" | "capabilities" | "role">;

export interface RolePolicyPort {
  enrollmentAcl(request: { space: string; role: string; roleTreeRevision: number; seatName: string }): Promise<{ base: EnrollmentAcl; overrides: EnrollmentAcl[] }>;
}


export interface PlacementEnrollmentAuthorityOptions {
  dir: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
  reconciler: ReconcilerPort;
  authenticator: ServiceAuthenticator;
  rolePolicy: RolePolicyPort;
  serializedForAlias<T>(owner: string, actor: string, action: () => Promise<T>): Promise<T>;
  deprovisionFootprint(owner: string, actor: string, lifecycleUid: string, channels: string[]): Promise<void>;
  enrollManagedAgent(args: {
    owner: string;
    scope: string[];
    request: PlacementEnrollmentRequest["enrollment"];
    sentinelCreds: string;
    agentBearerExchangeUrl: string;
  }): Promise<RemoteManagedAgentEnrollmentResult>;
  assertOpen(): void;
  log(line: string): void;
}

/** The verify result: the committed identity, active once it verifies. */
export interface VerifyPlacementResult { identity: EnrollmentIdentity; active: true }

/** The effect lifecycle state a status or close reports. */
export type PlacementEffectState = "effective" | "unknown" | "cancelled" | "pending";

/** The status and close result: the effect state plus its fence and custody facts. */
export interface PlacementEffectStatusResult {
  effectId: string;
  state: PlacementEffectState;
  enrollment?: EnrollmentIdentity;
  noLateEffects: boolean;
  privateCustody: "none";
}

/** The retire result: retired, pending, or unknown, with the denial proof once retired. */
export interface PlacementRetireResult { state: "retired" | "pending" | "unknown"; denialProofId?: string }

export interface PlacementEnrollmentAuthority {
  enrollPlacement(args: { owner: string; scope: string[]; request: unknown; sentinelCreds: string; agentBearerExchangeUrl: string; onDelivered: (release: () => void) => void }): Promise<PlacementEnrollmentResult>;
  verifyPlacementEnrollment(args: { caller: string; request: unknown }): Promise<VerifyPlacementResult>;
  enrollmentEffectStatus(args: { caller: string; effectId: string }): Promise<PlacementEffectStatusResult>;
  closeEnrollmentEffect(args: { caller: string; effectId: string; fenceId: string }): Promise<PlacementEffectStatusResult>;
  retirePlacementEnrollment(args: { caller: string; operationId: string; identity: EnrollmentIdentity; fenceId: string }): Promise<PlacementRetireResult>;
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
  authority: PlacementAuthorityView;
  placement: AcceptedIntentView["intent"]["placement"];
  role: string;
  roleTreeRevision: number;
  policy: { kind: "base"; digest: string } | { kind: "override"; index: number; digest: string };
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
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, canonicalJson(value)); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, join(directory, name));
  } finally { unlinkSync(temporary); }
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

function businessDigest(request: PlacementEnrollmentRequest, policy: PendingRecord["policy"]): string {
  const enrollment = request.enrollment;
  return contractDigest({
    acceptanceId: request.acceptanceId,
    enrollmentOperationId: request.enrollmentOperationId,
    placementOperationId: request.authority.placementOperationId,
    intentDigest: request.authority.intentDigest,
    actorTokenHash: request.actorTokenHash,
    policy,
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

function normalizedAcl(acl: EnrollmentAcl) {
  const subscribe = acl.subscribe ?? [];
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return { subscribe: sorted(subscribe), allowSubscribe: sorted(resolveReadAcl(subscribe, acl.allowSubscribe)),
    allowPublish: sorted(acl.allowPublish ?? []), capabilities: sorted(acl.capabilities ?? []), role: acl.role ?? null };
}

async function matchPolicy(options: PlacementEnrollmentAuthorityOptions, request: PlacementEnrollmentRequest, role: string, roleTreeRevision: number, seatName: string): Promise<PendingRecord["policy"]> {
  const policy = await options.rolePolicy.enrollmentAcl({ space: request.enrollment.space, role, roleTreeRevision, seatName });
  const actual = canonicalJson(normalizedAcl(request.enrollment.target));
  const base = normalizedAcl(policy.base);
  if (canonicalJson(base) === actual) return { kind: "base", digest: contractDigest(base) };
  const matches = policy.overrides.map((acl, index) => ({ acl: normalizedAcl(acl), index })).filter((entry) => canonicalJson(entry.acl) === actual);
  if (matches.length !== 1) throw new EpEnvelopeError("permission-denied", "enrollment ACL does not match role policy");
  const match = matches[0];
  if (!match) throw new EpEnvelopeError("permission-denied", "enrollment ACL does not match role policy");
  return { kind: "override", index: match.index, digest: contractDigest(match.acl) };
}

function sameAuthority(a: PlacementAuthorityView, b: PlacementAuthorityView): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function parseAccepted(raw: unknown, authority: PlacementAuthorityView): AcceptedIntentView {
  if (!isObject(raw) || !isObject(raw.intent) || !isObject(raw.intent.placement) || !isObject(raw.executionGate) || !isObject(raw.executionGate.authority))
    fail("unavailable", "reconciler accepted-intent answer is malformed", "unknown");
  const accepted = raw as unknown as AcceptedIntentView;
  const { digest, ...intent } = accepted.intent;
  if (!UUID.test(accepted.acceptanceId) || !UUID.test(accepted.enrollmentOperationId) ||
      !uint(accepted.acceptedListRevision) || !uint(accepted.acceptedSeatRevision) ||
      accepted.acceptanceId !== authority.subject.acceptanceId || accepted.enrollmentOperationId !== authority.subject.enrollmentOperationId ||
      typeof accepted.intent.role !== "string" || accepted.intent.role.length === 0 || !uint(accepted.intent.roleTreeRevision) ||
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

function parseEffect(raw: unknown, authority: PlacementAuthorityView, accepted: AcceptedIntentView): EnrollEffectView {
  if (!isObject(raw) || !isObject(raw.authority)) fail("unavailable", "reconciler enrollment effect is malformed", "unknown");
  const effect = raw as unknown as EnrollEffectView;
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
    if (savedClaim.instanceId !== currentClaim.instanceId ||
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

async function managerEnrollment(options: PlacementEnrollmentAuthorityOptions, owner: string, scope: string[], request: PlacementEnrollmentRequest, sentinelCreds: string, agentBearerExchangeUrl: string): Promise<RemoteManagedAgentEnrollmentResult> {
  return options.enrollManagedAgent({ owner, scope, request: request.enrollment, sentinelCreds, agentBearerExchangeUrl });
}

function verifyMaterial(result: RemoteManagedAgentEnrollmentResult, request: PlacementEnrollmentRequest, owner: string): string {
  if (result.v !== 1 || result.kind !== "manager-managed-agent-enrollment" || result.space !== request.enrollment.space ||
      result.owner !== owner || result.actor !== request.enrollment.actor || result.instanceId !== request.enrollment.instanceId ||
      result.managerLifecycleUid !== request.enrollment.managerLifecycleUid || result.requestId !== request.enrollment.requestId ||
      result.serveEpoch !== request.enrollment.serveEpoch || result.material.owner !== owner ||
      result.material.actor !== request.enrollment.target.actor)
    fail("unavailable", "managed enrollment returned material for another placement", "unknown");
  try { return assertLifecycleToken(result.material.lifecycleUid); }
  catch { return fail("unavailable", "managed enrollment returned an invalid lifecycle uid", "unknown"); }
}

export function boundPlacementDelivery(release: () => void, destroy: () => void, boundMs = 30_000): () => void {
  let released = false;
  const timer = setTimeout(() => { destroy(); finish(); }, boundMs);
  const finish = () => { clearTimeout(timer); if (!released) { released = true; release(); } };
  return finish;
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
    if (!gate || gate.registrationRevision !== request.authority.claim.currentRegistrationRevision || gate.processEpoch !== request.authority.claim.serveEpoch)
      fail("permission-denied", "placement enrollment claim does not match current manager registration", "not-executed");

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
        const candidate = complete ?? pending;
        if (!isObject(candidate) || typeof candidate.role !== "string" || !uint(candidate.roleTreeRevision) || !isObject(candidate.placement) || typeof candidate.placement.name !== "string")
          throw new EpEnvelopeError("unavailable", "placement enrollment journal lacks role policy context");
        const policy = await matchPolicy(options, request, candidate.role, candidate.roleTreeRevision, candidate.placement.name);
        const stored = parseStoredRecord(candidate, request, businessDigest(request, policy));
        if (stored.owner !== args.owner) fail("permission-denied", "placement enrollment belongs to another owner", "not-executed");
        effectLease = await acquireLockAsync(join(directory, `${stored.effectId}.effect.lock`), { label: "enrollment effect" });
        const indexName = `${stored.effectId}.index.json`;
        const index = readRecord<unknown>(directory, indexName);
        if (index === undefined) durableCreate(directory, indexName, { operationId: request.enrollmentOperationId });
        else if (!isObject(index) || index.operationId !== request.enrollmentOperationId)
          fail("conflict", "placement enrollment effect belongs to another operation");
        if (readRecord<unknown>(directory, `${stored.effectId}.cancelled.json`) !== undefined)
          fail("failed-precondition", "placement enrollment was not executed", "not-executed");
        const latest = readRecord<unknown>(directory, completeName);
        if (latest !== undefined) complete = parseStoredRecord(latest, request, businessDigest(request, policy));
        if (readRecord<unknown>(directory, `${stored.effectId}.closed.json`) !== undefined)
          fail("failed-precondition", "placement enrollment effect is closed", "not-executed");
        const lifecycleUid = assertHeldRow(options, args.owner, authorized.target.actor, request.actorTokenHash, request.authority.claim.instanceId,
          stored.state === "complete" ? stored.identity.target.lifecycle.lifecycleUid : undefined);
        if (lifecycleUid === undefined) throw new EpEnvelopeError("unavailable", "placement enrollment outcome is unknown; the recorded grant is absent", undefined, "unknown");
        const result = await managerEnrollment(options, args.owner, args.scope, request, args.sentinelCreds, args.agentBearerExchangeUrl);
        if (verifyMaterial(result, request, args.owner) !== lifecycleUid)
          fail("conflict", "managed enrollment replay returned another lifecycle", "unknown");
        if (stored.state === "pending" && complete === undefined) {
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
      const policy = await matchPolicy(options, request, accepted.intent.role, accepted.intent.roleTreeRevision, accepted.intent.placement.name);
      effectLease = await acquireLockAsync(join(directory, `${effect.effectId}.effect.lock`), { label: "enrollment effect" });
      if (readRecord<unknown>(directory, `${effect.effectId}.closed.json`) !== undefined)
        fail("failed-precondition", "placement enrollment effect is closed", "not-executed");
      options.assertOpen();
      const record: PendingRecord = {
        v: 1,
        state: "pending",
        requestDigest: businessDigest(request, policy),
        effectId: effect.effectId,
        owner: args.owner,
        acceptanceId: request.acceptanceId,
        enrollmentOperationId: request.enrollmentOperationId,
        actorTokenHash: request.actorTokenHash,
        authority: request.authority,
        placement: accepted.intent.placement,
        role: accepted.intent.role,
        roleTreeRevision: accepted.intent.roleTreeRevision,
        policy,
      };
      const indexName = `${effect.effectId}.index.json`;
      const index = readRecord<unknown>(directory, indexName);
      if (index === undefined) durableCreate(directory, indexName, { operationId: request.enrollmentOperationId });
      else if (!isObject(index) || index.operationId !== request.enrollmentOperationId)
        fail("conflict", "placement enrollment effect belongs to another operation");
      durableCreate(directory, pendingName, record);
      options.assertOpen();
      let result: RemoteManagedAgentEnrollmentResult;
      try {
        result = await managerEnrollment(options, args.owner, args.scope, request, args.sentinelCreds, args.agentBearerExchangeUrl);
      } catch (error) {
        const row = findManagedActor(options.dir, args.owner, authorized.target.actor);
        if (!row || row.tokenHash !== request.actorTokenHash) {
          durableCreate(directory, `${effect.effectId}.cancelled.json`, { effectId: effect.effectId });
          fail("failed-precondition", "placement enrollment was not executed", "not-executed");
        }
        throw error;
      }
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

  const authenticate = async (caller: string, operation: string, request: unknown) => {
    if ((await options.authenticator.authenticateService({ transportPrincipal: caller, operation, requestDigest: contractDigest(request) })).principal !== "reconciler")
      fail("permission-denied", "enrollment participant requires the reconciler service", "not-executed");
  };
  const effectStatus = async (effectId: string) => {
    if (!UUID.test(effectId)) fail("bad-request", "invalid effect id");
    const lease = await acquireLockAsync(join(directory, `${effectId}.effect.lock`), { label: "enrollment effect" });
    try {
    let complete: CompleteRecord | undefined;
    let pending: PendingRecord | undefined;
    const index = readRecord<unknown>(directory, `${effectId}.index.json`);
    if (index !== undefined) {
      if (!isObject(index) || typeof index.operationId !== "string" || !UUID.test(index.operationId))
        throw new EpEnvelopeError("unavailable", "placement enrollment effect index is corrupt");
      complete = readRecord<CompleteRecord>(directory, `${index.operationId}.complete.json`);
      pending = readRecord<PendingRecord>(directory, `${index.operationId}.pending.json`);
      if ((complete && complete.effectId !== effectId) || (pending && pending.effectId !== effectId))
        fail("unavailable", "placement enrollment effect index does not match journal");
    }
    if (!complete && pending) {
      const uid = assertHeldRow(options, pending.owner, pending.placement.name, pending.actorTokenHash, pending.authority.claim.instanceId);
      if (uid) {
        complete = { ...pending, state: "complete", identity: identityFor(pending, pending.owner, uid) };
        durableCreate(directory, `${pending.enrollmentOperationId}.complete.json`, complete);
      }
    }
    const closed = readRecord<unknown>(directory, `${effectId}.closed.json`) !== undefined;
    const cancelled = readRecord<unknown>(directory, `${effectId}.cancelled.json`) !== undefined;
    return { effectId, state: complete ? "effective" as const : closed || cancelled ? "cancelled" as const : pending ? "unknown" as const : "pending" as const,
      ...(complete ? { enrollment: complete.identity } : {}), noLateEffects: closed || cancelled, privateCustody: "none" as const };
    } finally { lease.release(); }
  };
  const enrollmentEffectStatus = async ({ caller, effectId }: { caller: string; effectId: string }) => {
    await authenticate(caller, "auth.enrollment-effect-status", { effectId });
    return effectStatus(effectId);
  };
  const closeEnrollmentEffect = async ({ caller, effectId, fenceId }: { caller: string; effectId: string; fenceId: string }) => {
    await authenticate(caller, "auth.close-enrollment-effect", { effectId, fenceId });
    if (!UUID.test(effectId) || !UUID.test(fenceId)) fail("bad-request", "invalid effect or fence id");
    const timeout = new Error("enrollment effect lock timed out");
    const lease = await acquireLockAsync(join(directory, `${effectId}.effect.lock`), { label: "enrollment effect", waitMs: 30_000, onTimeout: () => timeout }).catch((error: unknown) => {
      if (error === timeout) return undefined;
      throw error;
    });
    if (!lease) return { effectId, state: "pending" as const, noLateEffects: false, privateCustody: "none" as const };
    try {
      const name = `${effectId}.closed.json`;
      const existing = readRecord<unknown>(directory, name);
      if (existing === undefined) durableCreate(directory, name, { effectId, fenceId });
      else if (!isObject(existing) || existing.fenceId !== fenceId || existing.effectId !== effectId)
        fail("conflict", "enrollment effect was closed by another fence");
    } finally { lease.release(); }
    return effectStatus(effectId);
  };
  const retirePlacementEnrollment = async ({ caller, operationId, identity, fenceId }: { caller: string; operationId: string; identity: EnrollmentIdentity; fenceId: string }) => {
    await authenticate(caller, "auth.retire-placement-enrollment", { operationId, identity, fenceId });
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
      const gone = await options.serializedForAlias(target.owner, target.actor, async () => {
        const row = findManagedActor(options.dir, target.owner, target.actor);
        if (row?.lifecycleUid === target.lifecycleUid) {
          if (row.tokenHash !== record.actorTokenHash || row.custody?.kind !== custody.kind || row.custody.instanceId !== custody.instanceId) return false;
          await options.deprovisionFootprint(target.owner, target.actor, target.lifecycleUid, row.allowSubscribe);
          withManagedGrantTransaction(options.dir, (tx) => tx.revokeManagedIf(target.owner, target.actor, { lifecycleUid: target.lifecycleUid, custody }));
        } else {
          await options.deprovisionFootprint(target.owner, target.actor, target.lifecycleUid, []);
        }
        const after = findManagedActor(options.dir, target.owner, target.actor);
        return !after || after.lifecycleUid !== target.lifecycleUid;
      }).catch((error: unknown) => {
        options.log(`auth-service: placement enrollment retirement ${operationId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
      if (!gone) return { state: "unknown" as const };
      const denialProofId = contractDigest({ operationId, identity, fenceId, grantGone: true, footprintGone: true });
      durableCreate(directory, name, { operationId, identity, fenceId, grantGone: true, footprintGone: true, denialProofId });
      return { state: "retired" as const, denialProofId };
    } finally { lock.release(); }
  };

  const verifyPlacementEnrollment = async (args: { caller: string; request: unknown }): Promise<{ identity: EnrollmentIdentity; active: true }> => {
    options.assertOpen();
    const request = parsePlacementEnrollmentVerificationRequest(args.request);
    await authenticate(args.caller, "auth.verify-placement-enrollment", request);
    const { identity, claim } = request;
    if (identity.target.lifecycle.space !== options.space || claim.accountPublicKey !== options.accountPublicKey)
      fail("permission-denied", "placement enrollment verification names another space or account", "not-executed");
    const complete = readRecord<unknown>(directory, `${identity.enrollmentOperationId}.complete.json`);
    if (complete === undefined) fail("failed-precondition", "placement enrollment is not durably committed", "not-executed");
    if (!isObject(complete) || complete.state !== "complete" || !isObject(complete.identity) ||
        canonicalJson(complete.identity) !== canonicalJson(identity) || complete.enrollmentOperationId !== identity.enrollmentOperationId)
      fail("permission-denied", "placement enrollment identity differs from the durable record", "not-executed");
    const gate = await options.observeManagerGate(claim.instanceId);
    if (!gate || gate.state !== "open" || gate.principal !== remoteManagerServePrincipal(identity.target.lifecycle.owner, claim.instanceId) ||
        gate.processEpoch !== claim.serveEpoch || gate.registrationRevision !== claim.currentRegistrationRevision)
      fail("permission-denied", "placement enrollment verification claim is not the current open manager registration", "not-executed");
    const record = complete as unknown as CompleteRecord;
    if (record.authority.claim.instanceId !== claim.instanceId || record.authority.claim.accountPublicKey !== claim.accountPublicKey ||
        record.authority.claim.assignmentRevision !== claim.assignmentRevision)
      fail("permission-denied", "placement enrollment claim differs from its recorded assignment", "not-executed");
    const lifecycleUid = assertHeldRow(options, identity.target.lifecycle.owner, identity.target.lifecycle.actor,
      record.actorTokenHash, claim.instanceId, identity.target.lifecycle.lifecycleUid);
    if (lifecycleUid === undefined) fail("failed-precondition", "placement enrollment is no longer active", "not-executed");
    return { identity, active: true };
  };

  return { enrollPlacement, verifyPlacementEnrollment, enrollmentEffectStatus, closeEnrollmentEffect, retirePlacementEnrollment };
}

