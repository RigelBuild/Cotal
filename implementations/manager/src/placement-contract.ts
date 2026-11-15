import { EpEnvelopeError } from "@cotal-ai/core";

const uint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const text = { type: "string", minLength: 1 } as const;
const object = { type: "object" } as const;
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
const intent = closed(["placement", "cwd", "workspaceDigest", "persona", "personaDigest", "profile", "role", "roleTreeRevision", "assets", "key", "policyRevision", "restartGeneration", "digest"], {
  placement, cwd: text, workspaceDigest: text, persona: text, personaDigest: text, cardRole: text,
  profile, role: text, roleTreeRevision: uint, assets: object, key: object, policyRevision: uint,
  restartGeneration: uint, handoff: object, digest: text,
});
const accepted = closed(["acceptanceId", "intent", "acceptedListRevision", "acceptedSeatRevision", "enrollmentOperationId", "executionGate"], {
  acceptanceId: text, intent, acceptedListRevision: uint, acceptedSeatRevision: uint,
  enrollmentOperationId: text, executionGate: object,
});
const observation = closed(["placement", "state", "obligations"], {
  placement, lifecycle: object, state: { enum: ["pending", "starting", "running", "stopping", "stopped", "unknown", "parked"] },
  executionIdentity: text, keyId: text, reason: text, key: object, obligations: { type: "array", items: object },
});
export const placementContracts = {
  place: { input: closed(["accepted"], { accepted }), output: closed(["observation", "executionGate"], { observation, executionGate: object }) },
  observe: { input: closed(["name", "generation"], { name: text, generation: uint }), output: observation },
  stopPlacement: { input: closed(["placement"], { placement }), output: observation },
  prepareLaunch: { input: closed(["placement", "entry"], { placement, entry: object }), output: intent },
  profileGet: { input: closed(["name"], { name: text }), output: profile },
} as const;

/** Refuse before side effects when the named provider is absent. */
export function placementUnsupported(seam: string): never {
  throw new EpEnvelopeError("unimplemented", `unsupported: ${seam} is not available`, undefined, "not-executed");
}
