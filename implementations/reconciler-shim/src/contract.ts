/**
 * fixed. The shim validates each body against these closed schemas, then forwards it to the Go
 * reconciler, which authorizes and journals every command. Shapes: launch-protocol.md § Agent
 * management. Result objects are not validated here, and Go also owns the exact UUID, digest,
 * RFC3339 and integer-range checks; the reconciler owns both.
 */
import { serviceContractTable, singleDocumentClosure, type EpCapability } from "@cotal-ai/core";

export const SEATS_ENDPOINT = "wave-seats";
export const SEATS_CLUSTER_URN = "ai.cotal.wave-seats";

const UUID = { type: "string", minLength: 36, maxLength: 36 } as const;
const NAME = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" } as const;
const TEXT = { type: "string", minLength: 1, maxLength: 4096 } as const;
const STAMP = { type: "string", minLength: 1, maxLength: 64 } as const;
const UINT = { type: "integer", minimum: 0 } as const;
const DIGEST = { type: "string", minLength: 1, maxLength: 128 } as const;
const HOST = { enum: ["k3s", "macbook", "mattmini"] } as const;
const HANDOFF_MODE = { enum: ["request", "skip"] } as const;
// Standard base64. The schema profile refuses a repeated quantified group, so the shim checks the
// padded length and the 256 KiB decoded cap (MAX_HANDOFF_BYTES) in the handler.
const BASE64 = { type: "string", maxLength: 349528, pattern: "^[A-Za-z0-9+/]*={0,2}$" } as const;
export const MAX_HANDOFF_BYTES = 256 * 1024;
const ACCOUNT = { anyOf: [{ enum: ["shared"] }, { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 128 } }] } as const;

/** A closed object: no key beyond `properties`, and every name in `required` present. */
const closed = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", additionalProperties: false, required, properties }) as const;

/** An operation body: the operation identity and the revision it expects, plus `properties`. */
const OPERATION = (properties: Record<string, unknown> = {}, required: string[] = []) =>
  closed({ operationId: UUID, name: NAME, expectedSeatRevision: UINT, ...properties }, ["operationId", "name", "expectedSeatRevision", ...required]);

const ROUTING = closed({ claude: ACCOUNT, codex: ACCOUNT });
const WINDOW = {
  anyOf: [
    closed({ kind: { enum: ["fixed"] }, seconds: UINT, anchorUtc: STAMP, timezone: STAMP }, ["kind", "seconds", "anchorUtc", "timezone"]),
    closed({ kind: { enum: ["rolling"] }, seconds: UINT }, ["kind", "seconds"]),
  ],
} as const;
const CAP = closed({ usd: { type: "number", minimum: 0 }, window: WINDOW }, ["usd", "window"]);
const MODEL_LIMIT = closed({ tokens: UINT, tpm: UINT, rpm: UINT });
const LIMITS = closed({ keyCap: CAP, perModel: { type: "object", additionalProperties: MODEL_LIMIT } });
const KEY_REQUEST = closed({ routing: ROUTING, limits: LIMITS }, ["routing", "limits"]);

const HANDOFF_REQUEST = closed(
  { restartOperationId: UUID, name: NAME, predecessorGeneration: UINT, restartGeneration: UINT },
  ["restartOperationId", "name", "predecessorGeneration", "restartGeneration"],
);
const ARTIFACT_REF = closed({ kind: { enum: ["wave-handoff/v1"] }, id: UUID }, ["kind", "id"]);

const SEAT_ADD = closed({
  operationId: UUID, name: NAME, cwd: TEXT, workspace: NAME, parent: NAME, host: HOST, profile: NAME, role: NAME,
  roleTreeRevision: UINT, persona: NAME, key: KEY_REQUEST, note: { type: "string", maxLength: 1024 },
}, ["operationId", "name", "cwd", "workspace", "profile", "role", "roleTreeRevision", "persona", "key"]);

const RESULT = { type: "object" } as const;
// Execution shapes from launch-protocol.md § Agent management, closed. Where auth's placement
// schemas (auth-service-contract.ts) describe the same record type, these match them field for field.
const DIGEST_STRING = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } as const;
// placement-enrollment-types.ts TOKEN_HASH: a bare lowercase SHA-256, with no sha256: prefix.
const TOKEN_HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const UUID_STRING = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const NONEMPTY = { type: "string", minLength: 1, maxLength: 512 } as const;
const OWNER_TOKEN = { type: "string", pattern: "^[A-Za-z0-9_]+$", minLength: 1, maxLength: 512 } as const;
const LIFECYCLE_TOKEN = { type: "string", pattern: "^[a-z0-9]{26,32}$" } as const;
const MANAGER_CLAIM = closed(
  {
    accountPublicKey: { type: "string", pattern: "^A[A-Z2-7]{55}$" },
    instanceId: LIFECYCLE_TOKEN,
    managerLifecycleUid: LIFECYCLE_TOKEN,
    assignmentRevision: UINT,
    currentRegistrationRevision: UINT,
    serveEpoch: UINT,
  },
  ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"],
);
const LIFECYCLE_TARGET = closed({ space: NONEMPTY, owner: OWNER_TOKEN, actor: OWNER_TOKEN, lifecycleUid: LIFECYCLE_TOKEN }, ["space", "owner", "actor", "lifecycleUid"]);
const AGENT_KEY_TARGET = closed({ seatName: NONEMPTY, lifecycle: LIFECYCLE_TARGET, generation: UINT }, ["seatName", "lifecycle", "generation"]);
// launch-protocol.md:85-88 EnrollmentIdentity; equal to auth's PLACEMENT_IDENTITY_SCHEMA.
const ENROLLMENT_IDENTITY = closed(
  { acceptanceId: UUID_STRING, enrollmentOperationId: UUID_STRING, enrollmentRef: NONEMPTY, target: AGENT_KEY_TARGET, intentDigest: DIGEST_STRING },
  ["acceptanceId", "enrollmentOperationId", "enrollmentRef", "target", "intentDigest"],
);
// launch-protocol.md:50-53 Placement.
const PLACEMENT = closed(
  { space: { enum: ["main"] }, name: NAME, desiredRevision: UINT, seatRevision: UINT, claim: MANAGER_CLAIM, generation: UINT, operationId: UUID, workspace: NAME },
  ["space", "name", "desiredRevision", "seatRevision", "claim", "generation", "operationId", "workspace"],
);
// launch-protocol.md:54-64 ProfileSnapshot and RuntimeAssets.
const PROFILE_SNAPSHOT = closed(
  { name: NAME, revision: STAMP, configRevision: STAMP, modelRoles: { type: "object", additionalProperties: { type: "string" } }, sha256: DIGEST_STRING },
  ["name", "revision", "configRevision", "modelRoles", "sha256"],
);
const RUNTIME_ASSETS = closed(
  {
    revision: STAMP, digest: DIGEST_STRING, imageDigest: STAMP, baselineConfigDigest: DIGEST_STRING, modelCatalogDigest: DIGEST_STRING,
    personaCatalogDigest: DIGEST_STRING, extensionsDigest: DIGEST_STRING, rulesSkillsDigest: DIGEST_STRING, cliClosureDigest: DIGEST_STRING,
    toolBindings: { type: "array", maxItems: 64, items: closed({ id: NAME, endpoint: NAME, entitlementRef: NAME }, ["id", "endpoint", "entitlementRef"]) },
  },
  ["revision", "digest", "imageDigest", "baselineConfigDigest", "modelCatalogDigest", "personaCatalogDigest", "extensionsDigest", "rulesSkillsDigest", "cliClosureDigest", "toolBindings"],
);
// launch-protocol.md:29 KeySettings adds policyId to KeyRequest. launch-protocol.md:270-271 HandoffInput is a document receipt or a skip.
const LAUNCH_KEY = closed({ routing: ROUTING, limits: LIMITS, policyId: NAME }, ["routing", "limits", "policyId"]);
// launch-protocol.md:270-271 HandoffInput: a document receipt, or a skip. The receipt is launch-protocol.md:267-269.
const HANDOFF_RECEIPT = closed(
  {
    receiptId: UUID, request: HANDOFF_REQUEST, lifecycle: LIFECYCLE_TARGET, artifactRef: ARTIFACT_REF,
    artifactDigest: DIGEST_STRING, sizeBytes: UINT, at: STAMP,
  },
  ["receiptId", "request", "lifecycle", "artifactRef", "artifactDigest", "sizeBytes", "at"],
);
const HANDOFF_INPUT = {
  oneOf: [
    closed({ mode: { enum: ["document"] }, receipt: HANDOFF_RECEIPT }, ["mode", "receipt"]),
    closed({ mode: { enum: ["none"] }, reason: { enum: ["skip", "not-running", "superseded"] } }, ["mode", "reason"]),
  ],
};
const LAUNCH_INTENT = closed(
  {
    placement: PLACEMENT, cwd: TEXT, workspaceDigest: DIGEST_STRING, persona: NAME, personaDigest: DIGEST_STRING, cardRole: NAME,
    profile: PROFILE_SNAPSHOT, role: NAME, roleTreeRevision: UINT, assets: RUNTIME_ASSETS, key: LAUNCH_KEY, policyRevision: UINT,
    restartGeneration: UINT, handoff: HANDOFF_INPUT, digest: DIGEST_STRING,
  },
  ["placement", "cwd", "workspaceDigest", "persona", "personaDigest", "profile", "role", "roleTreeRevision", "assets", "key", "policyRevision", "restartGeneration", "digest"],
);
// launch-protocol.md:830-835 ExecutionSubject (accepted phase) and ExecutionAuthority.
const EXECUTION_AUTHORITY = closed(
  {
    subject: {
      oneOf: [
        closed({ acceptanceId: UUID_STRING, enrollmentOperationId: UUID_STRING, phase: { enum: ["accepted"] } }, ["acceptanceId", "enrollmentOperationId", "phase"]),
        closed(
          { acceptanceId: UUID_STRING, enrollmentOperationId: UUID_STRING, phase: { enum: ["bound"] }, bindingId: UUID, target: AGENT_KEY_TARGET },
          ["acceptanceId", "enrollmentOperationId", "phase", "bindingId", "target"],
        ),
      ],
    },
    placementOperationId: UUID, intentDigest: DIGEST_STRING, claim: MANAGER_CLAIM, launchRevision: UINT,
  },
  ["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"],
);
const ROWS = [
  { name: "add", input: SEAT_ADD },
  { name: "remove", input: OPERATION() },
  { name: "pause", input: OPERATION() },
  { name: "resume", input: OPERATION() },
  { name: "restart", input: OPERATION({ handoff: HANDOFF_MODE }, ["handoff"]) },
  { name: "set-model", input: OPERATION({ profile: NAME, role: NAME, roleTreeRevision: UINT }, ["profile", "role", "roleTreeRevision"]) },
  { name: "set-key", input: OPERATION({ key: KEY_REQUEST }, ["key"]) },
  { name: "set-cwd", input: OPERATION({ cwd: TEXT, workspace: NAME }, ["cwd", "workspace"]) },
  { name: "get", input: closed({}) },
  { name: "status", input: closed({}) },
  { name: "handoff-upload", input: closed({ request: HANDOFF_REQUEST, content: BASE64 }, ["request", "content"]) },
  { name: "accept-intent", input: closed({ operationId: UUID, claim: MANAGER_CLAIM, intent: LAUNCH_INTENT }, ["operationId", "claim", "intent"]) },
  { name: "accepted-intent", input: closed({ acceptanceId: UUID_STRING, authority: EXECUTION_AUTHORITY, actorTokenHash: TOKEN_HASH }, ["acceptanceId", "authority", "actorTokenHash"]) },
  { name: "bind-enrollment", input: closed({ operationId: UUID, authority: EXECUTION_AUTHORITY, identity: ENROLLMENT_IDENTITY }, ["operationId", "authority", "identity"]) },
  {
    name: "handoff-receipt",
    input: closed({ request: HANDOFF_REQUEST, artifactRef: ARTIFACT_REF, artifactDigest: DIGEST }, ["request", "artifactRef", "artifactDigest"]),
  },
].map((row) => ({ ...row, output: RESULT }));

/** Every command token this endpoint serves, in catalog order. */
export const SEAT_COMMANDS: readonly string[] = ROWS.map((r) => r.name);

const TABLE = serviceContractTable(ROWS);

/** The compiled input/output pair per command, compiled on first access. */
export const SEAT_CONTRACTS = TABLE.contracts;

/** Every contract artifact a registration publishes: each distinct schema root and its manifest. */
export function seatContractArtifactValues(): unknown[] {
  return TABLE.artifactValues();
}

/** The cluster document a registration publishes beside the contract artifacts. */
export function seatClusterDocument() {
  return {
    urn: SEATS_CLUSTER_URN,
    revision: 1,
    attributes: [] as unknown[],
    events: [] as unknown[],
    commands: ROWS.map((r) => ({
      name: r.name,
      class: "ephemeral" as const,
      targeted: false,
      capability: r.name,
      inputDigest: singleDocumentClosure(r.input).closureDigest,
      outputDigest: singleDocumentClosure(r.output).closureDigest,
    })),
  };
}

/** The caller rows for every seat command on `endpoint`: what a caller credential carries, nothing more. */
export function seatCallerCapabilities(endpoint: string): EpCapability[] {
  return SEAT_COMMANDS.map((command) => ({ endpoint, command }));
}
