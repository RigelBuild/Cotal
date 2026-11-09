import { isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { isAccountNkey } from "./identity.js";
import { parseRemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult } from "./remote-manager-authority.js";
import { assertLifecycleToken, assertValidOwnerToken } from "./subjects.js";

export interface ManagerClaim {
  accountPublicKey: string;
  instanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  currentRegistrationRevision: number;
  serveEpoch: number;
}

export interface Placement {
  space: string;
  name: string;
  desiredRevision: number;
  seatRevision: number;
  claim: ManagerClaim;
  generation: number;
  operationId: string;
  workspace: string;
}

export interface ExecutionAuthority {
  subject: { acceptanceId: string; enrollmentOperationId: string; phase: "accepted" };
  placementOperationId: string;
  intentDigest: string;
  claim: ManagerClaim;
  launchRevision: number;
}

export interface AcceptedIntent {
  acceptanceId: string;
  intent: { digest: string; placement: Placement; [field: string]: unknown };
  acceptedListRevision: number;
  acceptedSeatRevision: number;
  enrollmentOperationId: string;
  executionGate: { authority: ExecutionAuthority; state: "open" | "closing" | "closed"; fenceId?: string };
}

export interface ExecutionEffect {
  effectId: string;
  authority: ExecutionAuthority;
  operationId: string;
  kind: "enroll" | "bind" | "create" | "bootstrap";
  state: "admitted" | "unknown" | "cancelled" | "effective";
  enrollment?: EnrollmentIdentity;
  stageId?: string;
  execution?: unknown;
}

export interface EnrollmentIdentity {
  acceptanceId: string;
  enrollmentOperationId: string;
  enrollmentRef: string;
  target: {
    seatName: string;
    lifecycle: { space: string; owner: string; actor: string; lifecycleUid: string };
    generation: number;
  };
  intentDigest: string;
}

export interface PlacementEnrollmentRequest {
  v: 1;
  kind: "auth.enroll-placement";
  acceptanceId: string;
  enrollmentOperationId: string;
  authority: ExecutionAuthority;
  actorTokenHash: string;
  enrollment: RemoteManagedAgentEnrollmentRequest;
}

export interface PlacementEnrollmentVerificationRequest {
  identity: EnrollmentIdentity;
  claim: ManagerClaim;
}

export interface PlacementEnrollmentResult {
  identity: EnrollmentIdentity;
  material: RemoteManagedAgentEnrollmentResult["material"];
}

/** Production binding comes with the reconciler integration. */
export interface ReconcilerPort {
  acceptedIntent(request: {
    acceptanceId: string;
    authority: ExecutionAuthority;
    actorTokenHash: string;
  }): Promise<{ accepted: AcceptedIntent; effect: ExecutionEffect }>;
}

/** Production binding comes with the reconciler integration. */
export interface ServiceAuthenticator {
  authenticateService(caller: string): Promise<{ principal: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function fail(what: string, message: string): never {
  throw new EpEnvelopeError("bad-request", `${what} ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], what: string): void {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...expected].sort().join(",")) fail(what, `must contain exactly ${expected.join(", ")}`);
}

function parseClaim(raw: unknown, what: string): ManagerClaim {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "claim must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"], what);
  if (!isAccountNkey(value.accountPublicKey) || typeof value.instanceId !== "string" || typeof value.managerLifecycleUid !== "string" ||
      !uint(value.assignmentRevision) || !uint(value.currentRegistrationRevision) || !uint(value.serveEpoch))
    fail(what, "claim fields are malformed");
  try {
    assertLifecycleToken(value.instanceId, "manager claim instanceId");
    assertLifecycleToken(value.managerLifecycleUid, "manager claim lifecycle uid");
  } catch {
    fail(what, "claim lifecycle tokens are malformed");
  }
  return {
    accountPublicKey: value.accountPublicKey,
    instanceId: value.instanceId,
    managerLifecycleUid: value.managerLifecycleUid,
    assignmentRevision: value.assignmentRevision,
    currentRegistrationRevision: value.currentRegistrationRevision,
    serveEpoch: value.serveEpoch,
  };
}

function parseAuthority(raw: unknown, what: string): ExecutionAuthority {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "authority must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"], what);
  if (value.subject === null || typeof value.subject !== "object" || Array.isArray(value.subject)) fail(what, "authority subject must be an object");
  const subject = value.subject as Record<string, unknown>;
  exactKeys(subject, ["acceptanceId", "enrollmentOperationId", "phase"], what);
  if (typeof subject.acceptanceId !== "string" || !UUID.test(subject.acceptanceId) ||
      typeof subject.enrollmentOperationId !== "string" || !UUID.test(subject.enrollmentOperationId) || subject.phase !== "accepted")
    fail(what, "authority subject must identify an accepted enrollment");
  if (typeof value.placementOperationId !== "string" || !UUID.test(value.placementOperationId) || !isContractDigest(value.intentDigest) ||
      !uint(value.launchRevision) || value.launchRevision < 1)
    fail(what, "authority placement, digest, or launch revision is malformed");
  return {
    subject: { acceptanceId: subject.acceptanceId, enrollmentOperationId: subject.enrollmentOperationId, phase: "accepted" },
    placementOperationId: value.placementOperationId,
    intentDigest: value.intentDigest,
    claim: parseClaim(value.claim, `${what} authority`),
    launchRevision: value.launchRevision,
  };
}

export function parsePlacementEnrollmentRequest(raw: unknown): PlacementEnrollmentRequest {
  const what = "placement enrollment request";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["v", "kind", "acceptanceId", "enrollmentOperationId", "authority", "actorTokenHash", "enrollment"], what);
  if (value.v !== 1 || value.kind !== "auth.enroll-placement") fail(what, "has an unsupported version or kind");
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) ||
      typeof value.enrollmentOperationId !== "string" || !UUID.test(value.enrollmentOperationId))
    fail(what, "requires UUID acceptance and enrollment operation ids");
  const authority = parseAuthority(value.authority, what);
  if (authority.subject.acceptanceId !== value.acceptanceId || authority.subject.enrollmentOperationId !== value.enrollmentOperationId)
    fail(what, "ids differ from the accepted execution subject");
  if (typeof value.actorTokenHash !== "string" || !TOKEN_HASH.test(value.actorTokenHash)) fail(what, "requires a lowercase SHA-256 actor token hash");
  const enrollment = parseRemoteManagedAgentEnrollmentRequest(value.enrollment);
  if (enrollment.target.tokenHash !== value.actorTokenHash) fail(what, "target token hash differs from actorTokenHash");
  if (enrollment.instanceId !== authority.claim.instanceId || enrollment.managerLifecycleUid !== authority.claim.managerLifecycleUid || enrollment.serveEpoch !== authority.claim.serveEpoch)
    fail(what, "manager instance, lifecycle, or serve epoch differs from the current claim");
  return { v: 1, kind: "auth.enroll-placement", acceptanceId: value.acceptanceId, enrollmentOperationId: value.enrollmentOperationId,
    authority, actorTokenHash: value.actorTokenHash, enrollment };
}

export function parsePlacementEnrollmentVerificationRequest(raw: unknown): PlacementEnrollmentVerificationRequest {
  const what = "placement enrollment verification request";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["identity", "claim"], what);
  return { identity: parseEnrollmentIdentity(value.identity, what), claim: parseClaim(value.claim, what) };
}

export function parseEnrollmentIdentity(raw: unknown, what = "placement enrollment identity"): EnrollmentIdentity {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["acceptanceId", "enrollmentOperationId", "enrollmentRef", "target", "intentDigest"], what);
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) ||
      typeof value.enrollmentOperationId !== "string" || !UUID.test(value.enrollmentOperationId) ||
      typeof value.enrollmentRef !== "string" || value.enrollmentRef.length === 0 || value.enrollmentRef.length > 512 || !isContractDigest(value.intentDigest))
    fail(what, "has malformed acceptance, operation, reference, or intent digest");
  if (value.target === null || typeof value.target !== "object" || Array.isArray(value.target)) fail(what, "target must be an object");
  const target = value.target as Record<string, unknown>;
  exactKeys(target, ["seatName", "lifecycle", "generation"], what);
  if (typeof target.seatName !== "string" || target.seatName.length === 0 || !uint(target.generation) ||
      target.lifecycle === null || typeof target.lifecycle !== "object" || Array.isArray(target.lifecycle))
    fail(what, "target fields are malformed");
  const lifecycle = target.lifecycle as Record<string, unknown>;
  exactKeys(lifecycle, ["space", "owner", "actor", "lifecycleUid"], what);
  if (typeof lifecycle.space !== "string" || lifecycle.space.length === 0 || typeof lifecycle.owner !== "string" ||
      typeof lifecycle.actor !== "string" || typeof lifecycle.lifecycleUid !== "string")
    fail(what, "target lifecycle fields are malformed");
  try {
    assertValidOwnerToken(lifecycle.owner);
    assertValidOwnerToken(lifecycle.actor);
    assertLifecycleToken(lifecycle.lifecycleUid);
  } catch {
    fail(what, "target lifecycle tokens are malformed");
  }
  return {
    acceptanceId: value.acceptanceId,
    enrollmentOperationId: value.enrollmentOperationId,
    enrollmentRef: value.enrollmentRef,
    target: { seatName: target.seatName, generation: target.generation,
      lifecycle: { space: lifecycle.space, owner: lifecycle.owner, actor: lifecycle.actor, lifecycleUid: lifecycle.lifecycleUid } },
    intentDigest: value.intentDigest,
  };
}
