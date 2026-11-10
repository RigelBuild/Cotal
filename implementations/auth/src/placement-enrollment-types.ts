import { assertLifecycleToken, assertValidOwnerToken, EpEnvelopeError, isAccountNkey, isContractDigest } from "@cotal-ai/core";
import type { PlacementEnrollmentRequest } from "@cotal-ai/core";
import type { EnrollmentIdentity, ManagerClaimView, PlacementEnrollmentVerificationRequest } from "./placement-enrollment.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function fail(what: string, message: string): never { throw new EpEnvelopeError("bad-request", `${what} ${message}`); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], what: string): void {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...expected].sort().join(",")) fail(what, `must contain exactly ${expected.join(", ")}`);
}

function parseClaim(raw: unknown, what: string): ManagerClaimView {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "claim must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"], what);
  if (!isAccountNkey(value.accountPublicKey) || typeof value.instanceId !== "string" || typeof value.managerLifecycleUid !== "string" ||
      !uint(value.assignmentRevision) || !uint(value.currentRegistrationRevision) || !uint(value.serveEpoch)) fail(what, "claim fields are malformed");
  try {
    assertLifecycleToken(value.instanceId, "manager claim instanceId");
    assertLifecycleToken(value.managerLifecycleUid, "manager claim lifecycle uid");
  } catch {
    fail(what, "claim lifecycle tokens are malformed");
  }
  return { accountPublicKey: value.accountPublicKey, instanceId: value.instanceId, managerLifecycleUid: value.managerLifecycleUid,
    assignmentRevision: value.assignmentRevision, currentRegistrationRevision: value.currentRegistrationRevision, serveEpoch: value.serveEpoch };
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
      target.lifecycle === null || typeof target.lifecycle !== "object" || Array.isArray(target.lifecycle)) fail(what, "target fields are malformed");
  const lifecycle = target.lifecycle as Record<string, unknown>;
  exactKeys(lifecycle, ["space", "owner", "actor", "lifecycleUid"], what);
  if (typeof lifecycle.space !== "string" || lifecycle.space.length === 0 || typeof lifecycle.owner !== "string" ||
      typeof lifecycle.actor !== "string" || typeof lifecycle.lifecycleUid !== "string") fail(what, "target lifecycle fields are malformed");
  try {
    assertValidOwnerToken(lifecycle.owner);
    assertValidOwnerToken(lifecycle.actor);
    assertLifecycleToken(lifecycle.lifecycleUid);
  } catch {
    fail(what, "target lifecycle tokens are malformed");
  }
  return { acceptanceId: value.acceptanceId, enrollmentOperationId: value.enrollmentOperationId, enrollmentRef: value.enrollmentRef,
    target: { seatName: target.seatName, generation: target.generation,
      lifecycle: { space: lifecycle.space, owner: lifecycle.owner, actor: lifecycle.actor, lifecycleUid: lifecycle.lifecycleUid } }, intentDigest: value.intentDigest };
}

