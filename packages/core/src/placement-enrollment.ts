import { EpEnvelopeError } from "./endpoint-error.js";
import { parseExecutionAuthority, type ExecutionAuthority } from "./placement-launch.js";
import { parseRemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult } from "./remote-manager-authority.js";

export interface PlacementEnrollmentRequest {
  v: 1;
  kind: "auth.enroll-placement";
  acceptanceId: string;
  enrollmentOperationId: string;
  authority: ExecutionAuthority;
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

export function parsePlacementEnrollmentRequest(raw: unknown): PlacementEnrollmentRequest {
  const what = "placement enrollment request";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["v", "kind", "acceptanceId", "enrollmentOperationId", "authority", "actorTokenHash", "enrollment"], what);
  if (value.v !== 1 || value.kind !== "auth.enroll-placement") fail(what, "has an unsupported version or kind");
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) || typeof value.enrollmentOperationId !== "string" || !UUID.test(value.enrollmentOperationId))
    fail(what, "requires UUID acceptance and enrollment operation ids");
  const authority = parseExecutionAuthority(value.authority, `${what} authority`);
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
