import { isContractDigest } from "./canonical-json.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { isAccountNkey } from "./identity.js";
import { parseRemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult } from "./remote-manager-authority.js";
import { assertLifecycleToken } from "./subjects.js";

export interface PlacementEnrollmentRequest {
  v: 1;
  kind: "auth.enroll-placement";
  acceptanceId: string;
  enrollmentOperationId: string;
  authority: {
    subject: { acceptanceId: string; enrollmentOperationId: string; phase: "accepted" };
    placementOperationId: string;
    intentDigest: string;
    claim: { accountPublicKey: string; instanceId: string; managerLifecycleUid: string; assignmentRevision: number; currentRegistrationRevision: number; serveEpoch: number };
    launchRevision: number;
  };
  actorTokenHash: string;
  enrollment: RemoteManagedAgentEnrollmentRequest;
}

export interface PlacementEnrollmentResult {
  identity: { acceptanceId: string; enrollmentOperationId: string; enrollmentRef: string;
    target: { seatName: string; lifecycle: { space: string; owner: string; actor: string; lifecycleUid: string }; generation: number };
    intentDigest: string };
  material: RemoteManagedAgentEnrollmentResult["material"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function fail(what: string, message: string): never { throw new EpEnvelopeError("bad-request", `${what} ${message}`); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], what: string): void {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...expected].sort().join(",")) fail(what, `must contain exactly ${expected.join(", ")}`);
}

function parseClaim(raw: unknown, what: string): PlacementEnrollmentRequest["authority"]["claim"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "claim must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"], what);
  if (!isAccountNkey(value.accountPublicKey) || typeof value.instanceId !== "string" || typeof value.managerLifecycleUid !== "string" ||
      !uint(value.assignmentRevision) || !uint(value.currentRegistrationRevision) || !uint(value.serveEpoch)) fail(what, "claim fields are malformed");
  try { assertLifecycleToken(value.instanceId, "manager claim instanceId"); assertLifecycleToken(value.managerLifecycleUid, "manager claim lifecycle uid"); }
  catch { fail(what, "claim lifecycle tokens are malformed"); }
  return { accountPublicKey: value.accountPublicKey, instanceId: value.instanceId, managerLifecycleUid: value.managerLifecycleUid,
    assignmentRevision: value.assignmentRevision, currentRegistrationRevision: value.currentRegistrationRevision, serveEpoch: value.serveEpoch };
}

function parseAuthority(raw: unknown, what: string): PlacementEnrollmentRequest["authority"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "authority must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"], what);
  if (value.subject === null || typeof value.subject !== "object" || Array.isArray(value.subject)) fail(what, "authority subject must be an object");
  const subject = value.subject as Record<string, unknown>;
  exactKeys(subject, ["acceptanceId", "enrollmentOperationId", "phase"], what);
  if (typeof subject.acceptanceId !== "string" || !UUID.test(subject.acceptanceId) || typeof subject.enrollmentOperationId !== "string" ||
      !UUID.test(subject.enrollmentOperationId) || subject.phase !== "accepted") fail(what, "authority subject must identify an accepted enrollment");
  if (typeof value.placementOperationId !== "string" || !UUID.test(value.placementOperationId) || !isContractDigest(value.intentDigest) ||
      !uint(value.launchRevision) || value.launchRevision < 1) fail(what, "authority placement, digest, or launch revision is malformed");
  return { subject: { acceptanceId: subject.acceptanceId, enrollmentOperationId: subject.enrollmentOperationId, phase: "accepted" },
    placementOperationId: value.placementOperationId, intentDigest: value.intentDigest, claim: parseClaim(value.claim, `${what} authority`), launchRevision: value.launchRevision };
}

export function parsePlacementEnrollmentRequest(raw: unknown): PlacementEnrollmentRequest {
  const what = "placement enrollment request";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["v", "kind", "acceptanceId", "enrollmentOperationId", "authority", "actorTokenHash", "enrollment"], what);
  if (value.v !== 1 || value.kind !== "auth.enroll-placement") fail(what, "has an unsupported version or kind");
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) || typeof value.enrollmentOperationId !== "string" || !UUID.test(value.enrollmentOperationId))
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
