import { EpEnvelopeError } from "@cotal-ai/core";

const uint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const text = { type: "string", minLength: 1 } as const;
const closed = (required: readonly string[], properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required, properties,
});

const claim = closed(["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"], {
  accountPublicKey: text, instanceId: text, managerLifecycleUid: text,
  assignmentRevision: uint, currentRegistrationRevision: uint, serveEpoch: uint,
});
const placement = closed(["space", "name", "desiredRevision", "seatRevision", "claim", "generation", "operationId", "workspace"], {
  space: { const: "main" }, name: text, desiredRevision: uint, seatRevision: uint, claim,
  generation: uint, operationId: text, workspace: text,
});
const profile = closed(["name", "revision", "configRevision", "modelRoles", "sha256"], {
  name: text, revision: text, configRevision: text,
  modelRoles: { type: "object", additionalProperties: { type: "string" } }, sha256: text,
});
const lifecycle = closed(["space", "owner", "actor", "lifecycleUid"], { space: text, owner: text, actor: text, lifecycleUid: text });
const target = closed(["seatName", "lifecycle", "generation"], { seatName: text, lifecycle, generation: uint });
const subject = { anyOf: [
  closed(["acceptanceId", "enrollmentOperationId", "phase"], { acceptanceId: text, enrollmentOperationId: text, phase: { const: "accepted" } }),
  closed(["acceptanceId", "enrollmentOperationId", "phase", "bindingId", "target"], { acceptanceId: text, enrollmentOperationId: text, phase: { const: "bound" }, bindingId: text, target }),
] };
const authority = closed(["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"], { subject, placementOperationId: text, intentDigest: text, claim, launchRevision: uint });
const gate = closed(["authority", "state"], { authority, state: { enum: ["open", "closing", "closed"] }, fenceId: text });
const window = { anyOf: [closed(["kind", "seconds", "anchorUtc", "timezone"], { kind: { const: "fixed" }, seconds: uint, anchorUtc: text, timezone: text }), closed(["kind", "seconds"], { kind: { const: "rolling" }, seconds: uint })] };
const limits = closed([], { keyCap: closed(["usd", "window"], { usd: { type: "number" }, window }), perModel: { type: "object", additionalProperties: closed([], { tokens: uint, tpm: uint, rpm: uint }) } });
const selection = { anyOf: [{ const: "shared" }, { type: "array", items: text }] };
const key = closed(["routing", "limits", "policyId"], { routing: closed([], { claude: selection, codex: selection }), limits, policyId: text });
const assets = closed(["revision", "digest", "imageDigest", "baselineConfigDigest", "modelCatalogDigest", "personaCatalogDigest", "extensionsDigest", "rulesSkillsDigest", "cliClosureDigest", "toolBindings"], {
  revision: text, digest: text, imageDigest: text, baselineConfigDigest: text, modelCatalogDigest: text,
  personaCatalogDigest: text, extensionsDigest: text, rulesSkillsDigest: text, cliClosureDigest: text,
  toolBindings: { type: "array", items: closed(["id", "endpoint", "entitlementRef"], { id: text, endpoint: text, entitlementRef: text }) },
});
const handoffRequest = closed(["restartOperationId", "name", "predecessorGeneration", "restartGeneration"], { restartOperationId: text, name: text, predecessorGeneration: uint, restartGeneration: uint });
const receipt = closed(["receiptId", "request", "lifecycle", "artifactRef", "artifactDigest", "sizeBytes", "at"], { receiptId: text, request: handoffRequest, lifecycle, artifactRef: closed(["kind", "id"], { kind: { const: "wave-handoff/v1" }, id: text }), artifactDigest: text, sizeBytes: uint, at: text });
const handoff = { anyOf: [closed(["mode", "receipt"], { mode: { const: "document" }, receipt }), closed(["mode", "reason"], { mode: { const: "none" }, reason: { enum: ["skip", "not-running", "superseded"] } })] };
const entry = closed(["name", "seatRevision", "cwd", "tab", "state", "restartGeneration", "updatedAt", "profile", "role", "roleTreeRevision", "key", "workspace", "persona"], {
  name: text, seatRevision: uint, cwd: text, tab: text, state: { enum: ["active", "paused", "retired"] }, restartGeneration: uint,
  parent: text, note: text, updatedAt: text, host: { enum: ["k3s", "macbook", "mattmini"] }, profile: text,
  role: text, roleTreeRevision: uint, key, workspace: text, persona: text, expiresAt: text,
});
const obligation = closed(["obligationId", "name", "generation", "reason", "committedRevision", "state"], { obligationId: text, name: text, generation: uint, reason: { enum: ["pause", "remove", "replace"] }, committedRevision: uint, state: { enum: ["pending", "unknown", "terminal"] }, deathProofId: text, keyDenialProofId: text });
const keyObservation = closed(["desiredAuthorizationRevision", "condition", "observedAt"], { desiredAuthorizationRevision: uint, appliedAuthorizationRevision: uint, settingsRevision: uint, operationId: text, condition: { enum: ["effective", "pending", "unknown", "rejected"] }, observedAt: text });
const intent = closed(["placement", "cwd", "workspaceDigest", "persona", "personaDigest", "profile", "role", "roleTreeRevision", "assets", "key", "policyRevision", "restartGeneration", "digest"], {
  placement, cwd: text, workspaceDigest: text, persona: text, personaDigest: text, cardRole: text,
  profile, role: text, roleTreeRevision: uint, assets, key, policyRevision: uint,
  restartGeneration: uint, handoff, digest: text,
});
const accepted = closed(["acceptanceId", "intent", "acceptedListRevision", "acceptedSeatRevision", "enrollmentOperationId", "executionGate"], {
  acceptanceId: text, intent, acceptedListRevision: uint, acceptedSeatRevision: uint,
  enrollmentOperationId: text, executionGate: gate,
});
const observation = closed(["placement", "state", "obligations"], {
  placement, lifecycle, state: { enum: ["pending", "starting", "running", "stopping", "stopped", "unknown", "parked"] },
  executionIdentity: text, keyId: text, reason: text, key: keyObservation, obligations: { type: "array", items: obligation },
});
export const placementContracts = {
  place: { input: closed(["accepted"], { accepted }), output: closed(["observation", "executionGate"], { observation, executionGate: gate }) },
  observe: { input: closed(["name", "generation"], { name: text, generation: uint }), output: observation },
  stopPlacement: { input: closed(["placement"], { placement }), output: observation },
  prepareLaunch: { input: closed(["placement", "entry"], { placement, entry }), output: intent },
  profileGet: { input: closed(["name"], { name: text }), output: profile },
} as const;

/** Refuse before side effects when the named provider is absent. */
export function placementUnsupported(seam: string): never {
  throw new EpEnvelopeError("unimplemented", `unsupported: ${seam} is not available`, undefined, "not-executed");
}
