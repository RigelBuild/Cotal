import { canonicalJson, EpEnvelopeError } from "@cotal-ai/core";
import type { AcceptedIntent, EnrollPlacementRequest, EnrollPlacementResult, ExecutionAuthority, ExecutionEffect, ManagerClaim } from "@cotal-ai/core";
import type { CotalEndpoint } from "@cotal-ai/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const WAVE_SEATS_ENDPOINT = "wave-seats";

export interface AcceptedPlacementAdmission {
  readonly accepted: AcceptedIntent;
  readonly effect: ExecutionEffect;
}

/** The reconciler-owned admission/read seam. Its endpoint is the authenticated caller for both calls. */
export class PlacementServiceClient {
  constructor(private readonly endpoint: CotalEndpoint) {}

  async acceptedIntent(request: { readonly acceptanceId: string; readonly authority: ExecutionAuthority; readonly actorTokenHash: string }): Promise<AcceptedPlacementAdmission> {
    const response = await this.endpoint.invokeService(WAVE_SEATS_ENDPOINT, "accepted-intent", request);
    if (response.reply.ok !== true) throw new EpEnvelopeError("unavailable", `wave-seats.accepted-intent refused: ${response.reply.error.message}`, undefined, "unknown");
    return parseAcceptedPlacementAdmission(response.reply.data, request);
  }

  async effectStatus(effectId: string): Promise<ExecutionEffect> {
    const response = await this.endpoint.invokeService(WAVE_SEATS_ENDPOINT, "execution-effect", { effectId });
    if (response.reply.ok !== true) throw new EpEnvelopeError("unavailable", `wave-seats.execution-effect refused: ${response.reply.error.message}`, undefined, "unknown");
    return parseExecutionEffect(response.reply.data);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAcceptedPlacementAdmission(raw: unknown, request: { acceptanceId: string; authority: ExecutionAuthority; actorTokenHash: string }): AcceptedPlacementAdmission {
  if (!isObject(raw) || !isObject(raw.accepted) || !isObject(raw.effect))
    throw new EpEnvelopeError("unavailable", "wave-seats.accepted-intent returned a malformed admission", undefined, "unknown");
  const acceptedRaw = raw.accepted;
  if (!isObject(acceptedRaw.intent) || !isObject(acceptedRaw.executionGate) || !isObject(acceptedRaw.executionGate.authority) ||
      !UUID.test(String(acceptedRaw.acceptanceId)) || !UUID.test(String(acceptedRaw.enrollmentOperationId)) ||
      !Number.isSafeInteger(acceptedRaw.acceptedListRevision) || !Number.isSafeInteger(acceptedRaw.acceptedSeatRevision))
    throw new EpEnvelopeError("unavailable", "wave-seats.accepted-intent returned an incomplete accepted intent", undefined, "unknown");
  const accepted = acceptedRaw as unknown as AcceptedIntent;
  const effect = parseExecutionEffect(raw.effect);
  const acceptedIntent = accepted.intent as unknown as { readonly digest?: unknown };
  if (accepted.acceptanceId !== request.acceptanceId || accepted.enrollmentOperationId !== request.authority.subject.enrollmentOperationId ||
      accepted.executionGate.state !== "open" || canonicalJson(accepted.executionGate.authority) !== canonicalJson(request.authority) ||
      !DIGEST.test(request.actorTokenHash) || acceptedIntent.digest !== request.authority.intentDigest ||
      effect.kind !== "enroll" || effect.state !== "admitted" || effect.operationId !== accepted.enrollmentOperationId ||
      canonicalJson(effect.authority) !== canonicalJson(request.authority) || effect.enrollment !== undefined)
    throw new EpEnvelopeError("permission-denied", "wave-seats.accepted-intent did not return the exact open enrollment admission", undefined, "not-executed");
  return { accepted, effect };
}

function parseExecutionEffect(raw: unknown): ExecutionEffect {
  if (!isObject(raw) || typeof raw.effectId !== "string" || !UUID.test(raw.effectId) || !isObject(raw.authority) || !isObject(raw.authority.subject) || !isObject(raw.authority.claim) ||
      typeof raw.operationId !== "string" || !UUID.test(raw.operationId) || (raw.kind !== "enroll" && raw.kind !== "bind" && raw.kind !== "create" && raw.kind !== "bootstrap") ||
      (raw.state !== "admitted" && raw.state !== "unknown" && raw.state !== "cancelled" && raw.state !== "effective"))
    throw new EpEnvelopeError("unavailable", "wave-seats returned a malformed execution effect", undefined, "unknown");
  return raw as unknown as ExecutionEffect;
}


export interface PlacementEnrollmentServices {
  enroll(request: EnrollPlacementRequest): Promise<EnrollPlacementResult>;
  verify(request: { readonly identity: EnrollPlacementResult["identity"]; readonly claim: ManagerClaim }): Promise<{ readonly identity: EnrollPlacementResult["identity"]; readonly active: true }>;
}
