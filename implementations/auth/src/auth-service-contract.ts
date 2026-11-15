/**
 * The AUTH plane's v0.4 SERVICE CONTRACT (#399 M2): the §13.7 cluster document + compiled command
 * contract for the `retire-lifecycle` op the auth plane serves on the `ep.*` rails. Shaped like
 * `implementations/manager/src/manager-service-contract.ts` (the manager's own contract module):
 * ONE `CommandRow`, its compiled input/output pair, and the cluster-document/artifact/command-def
 * builders a `serveEndpoint` registration needs.
 *
 * This module is PURE DATA + schema (no broker, no barrier, no wire I/O): the registration and
 * serve WIRING lives in the plane (`openAuthAuthorityPlane` / `openAuthAdminListener`).
 */
import {
  buildClusterArtifacts,
  buildClusterDocument,
  serviceContractTable,
  AUTH_ROSTER_INPUT_SCHEMA,
  AUTH_ROSTER_OUTPUT_SCHEMA,
  AUTH_ROSTER_COMMAND,
  type ClusterDocument,
  type ContractClosureManifest,
  type EpAuthzMode,
  type EpCommandDef,
  type EpServeContext,
  type AuthRosterInput,
  type AuthRosterOutput,
} from "@cotal-ai/core";

/** The auth plane's endpoint NAME (matches `AUTH_ENDPOINT` in `@cotal-ai/core`). */
export const AUTH_SERVICE_ENDPOINT = "auth";

/** The auth cluster document's URN (§13.7 content-addressed authority). */
export const AUTH_CLUSTER_URN = "ai.cotal.auth";

// ---- input/output schemas (closed shape) --------------------------------------------------------

/** The `retireLifecycle` args — the shape `parseRetireArgs` (`auth-admin.ts:146`) accepts. The
 *  target (owner, actor, lifecycleUid) is never an argument: `exact` mode carries it in the
 *  subject, broker-enforced, so the handler reads it from `ctx.subject.target`. */
const RETIRE_LIFECYCLE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opId", "serveEndpoint", "serveInstanceId", "serveEpoch"],
  properties: {
    /** The requester's stable operation id (a retry sends the SAME opId). */
    opId: { type: "string" },
    /** The serve-issuance gate's endpoint name the requester's serve grant is keyed under. */
    serveEndpoint: { type: "string" },
    /** The serve-issuance gate's instance id (lookup coordinate, not an authz input). */
    serveInstanceId: { type: "string" },
    /** The declared process epoch (a superseded predecessor is refused). */
    serveEpoch: { type: "integer", minimum: 0 },
  },
} as const;

/** The `retireLifecycle` output — the object the handler returns (`auth-admin.ts:390`). */
const RETIRE_LIFECYCLE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["retired", "lifecycleUid", "opId", "evictedPrincipals"],
  properties: {
    retired: { type: "boolean" },
    lifecycleUid: { type: "string" },
    opId: { type: "string" },
    evictedPrincipals: { type: "array", items: { type: "string" } },
  },
} as const;

/** Shared bounded shapes. Each mirrors the port's parser so the published contract never advertises
 *  a value the port would refuse: UUIDs (placement-enrollment.ts `UUID`), contract digests
 *  (`canonical-json.ts` DIGEST_RE), account nkeys (`identity.ts`), lifecycle tokens (`subjects.ts`). */
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const ACCOUNT_NKEY_PATTERN = "^A[A-Z2-7]{55}$";
const LIFECYCLE_TOKEN_PATTERN = "^[a-z0-9]{26,32}$";
const OWNER_TOKEN_PATTERN = "^[A-Za-z0-9_]+$";
const uuid = { type: "string", pattern: UUID_PATTERN } as const;
const nonEmpty = { type: "string", minLength: 1, maxLength: 512 } as const;
const ownerToken = { type: "string", pattern: OWNER_TOKEN_PATTERN, minLength: 1, maxLength: 512 } as const;

/** The placement participant `identity` (`EnrollmentIdentity`, placement-enrollment-types.ts). Closed. */
const PLACEMENT_IDENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["acceptanceId", "enrollmentOperationId", "enrollmentRef", "target", "intentDigest"],
  properties: {
    acceptanceId: uuid,
    enrollmentOperationId: uuid,
    enrollmentRef: { type: "string", minLength: 1, maxLength: 512 },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["seatName", "lifecycle", "generation"],
      properties: {
        seatName: nonEmpty,
        lifecycle: {
          type: "object",
          additionalProperties: false,
          required: ["space", "owner", "actor", "lifecycleUid"],
          properties: {
            space: nonEmpty,
            owner: ownerToken,
            actor: ownerToken,
            lifecycleUid: { type: "string", pattern: LIFECYCLE_TOKEN_PATTERN },
          },
        },
        generation: { type: "integer", minimum: 0 },
      },
    },
    intentDigest: { type: "string", pattern: DIGEST_PATTERN },
  },
} as const;

/** The placement participant `ManagerClaimView`. Closed. */
const PLACEMENT_CLAIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"],
  properties: {
    accountPublicKey: { type: "string", pattern: ACCOUNT_NKEY_PATTERN },
    instanceId: { type: "string", pattern: LIFECYCLE_TOKEN_PATTERN },
    managerLifecycleUid: { type: "string", pattern: LIFECYCLE_TOKEN_PATTERN },
    assignmentRevision: { type: "integer", minimum: 0 },
    currentRegistrationRevision: { type: "integer", minimum: 0 },
    serveEpoch: { type: "integer", minimum: 0 },
  },
} as const;

/** The placement participant status view (`enrollmentEffectStatus`, `closeEnrollmentEffect`). */
const PLACEMENT_STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["effectId", "state", "noLateEffects", "privateCustody"],
  properties: {
    effectId: uuid,
    state: { type: "string", enum: ["effective", "unknown", "cancelled", "pending"] },
    enrollment: PLACEMENT_IDENTITY_SCHEMA,
    noLateEffects: { type: "boolean" },
    privateCustody: { type: "string", enum: ["none"] },
  },
} as const;

const VERIFY_PLACEMENT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identity", "claim"],
  properties: { identity: PLACEMENT_IDENTITY_SCHEMA, claim: PLACEMENT_CLAIM_SCHEMA },
} as const;

const VERIFY_PLACEMENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identity", "active"],
  properties: { identity: PLACEMENT_IDENTITY_SCHEMA, active: { type: "boolean", const: true } },
} as const;

const EFFECT_STATUS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["effectId"],
  properties: { effectId: uuid },
} as const;

const CLOSE_EFFECT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["effectId", "fenceId"],
  properties: { effectId: uuid, fenceId: uuid },
} as const;

const RETIRE_PLACEMENT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operationId", "identity", "fenceId"],
  properties: { operationId: uuid, identity: PLACEMENT_IDENTITY_SCHEMA, fenceId: uuid },
} as const;

/** The retire output. `denialProofId` is present exactly when `state` is `retired`: the port never
 *  pairs a proof with any other state, and never returns `retired` without one (`oneOf` makes the
 *  two branches exclusive). */
const RETIRE_PLACEMENT_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "denialProofId"],
      properties: { state: { type: "string", const: "retired" }, denialProofId: { type: "string", pattern: DIGEST_PATTERN } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: { state: { type: "string", enum: ["pending", "unknown"] } },
    },
  ],
} as const;

interface CommandRow {
  name: "retire-lifecycle" | typeof AUTH_ROSTER_COMMAND | "verify-placement-enrollment" | "enrollment-effect-status" | "close-enrollment-effect" | "retire-placement-enrollment";
  capability: string;
  input: unknown;
  output: unknown;
  targeted: boolean;
  modes?: EpAuthzMode[];
}

const PLACEMENT_CAPABILITY = "auth.placement";
// Keep validator and published artifacts independent of the exported schema objects.
const ROSTER_INPUT_SCHEMA = structuredClone(AUTH_ROSTER_INPUT_SCHEMA);
const ROSTER_OUTPUT_SCHEMA = structuredClone(AUTH_ROSTER_OUTPUT_SCHEMA);

const ROWS: CommandRow[] = [
  { name: "retire-lifecycle", capability: "auth.admin", input: RETIRE_LIFECYCLE_INPUT_SCHEMA, output: RETIRE_LIFECYCLE_OUTPUT_SCHEMA, targeted: true, modes: ["exact"] },
  { name: "verify-placement-enrollment", capability: PLACEMENT_CAPABILITY, input: VERIFY_PLACEMENT_INPUT_SCHEMA, output: VERIFY_PLACEMENT_OUTPUT_SCHEMA, targeted: false },
  { name: "enrollment-effect-status", capability: PLACEMENT_CAPABILITY, input: EFFECT_STATUS_INPUT_SCHEMA, output: PLACEMENT_STATUS_SCHEMA, targeted: false },
  { name: "close-enrollment-effect", capability: PLACEMENT_CAPABILITY, input: CLOSE_EFFECT_INPUT_SCHEMA, output: PLACEMENT_STATUS_SCHEMA, targeted: false },
  { name: "retire-placement-enrollment", capability: PLACEMENT_CAPABILITY, input: RETIRE_PLACEMENT_INPUT_SCHEMA, output: RETIRE_PLACEMENT_OUTPUT_SCHEMA, targeted: false },
  { name: AUTH_ROSTER_COMMAND, capability: "auth.roster", input: ROSTER_INPUT_SCHEMA, output: ROSTER_OUTPUT_SCHEMA, targeted: false },
];

/** The placement participant commands, served by the auth endpoint and admitted only from the
 *  configured reconciler identity. Derived from {@link ROWS}, so the names cannot drift. */
export const AUTH_PLACEMENT_COMMANDS: readonly string[] = ROWS.filter((r) => r.capability === PLACEMENT_CAPABILITY).map((r) => r.name);

const TABLE = serviceContractTable(ROWS);

/** Per-command compiled contract pairs, exported for CALLERS (mirrors `MANAGER_CONTRACTS`). Lazy:
 *  a pair compiles on its first access, so importing the module alone pays no Ajv compile. */
export const AUTH_CONTRACTS = TABLE.contracts;

/** Every §13.7 contract artifact the auth plane PUBLISHES to the EPC store at registration: each
 *  DISTINCT schema root plus its single-member closure manifest. */
export const authContractArtifactValues = TABLE.artifactValues;

/** Revision 3 adds roster to the placement and retirement commands. */
export function authClusterDocument(): ClusterDocument {
  return buildClusterDocument(AUTH_CLUSTER_URN, 3, ROWS);
}

/** The two-digest §13.7 content addressing for the auth document: both artifacts publish to the
 *  `epc` store at their own digest; `clusterDigests` in the service spec carries the closure
 *  digest. */
export function authClusterArtifacts(): {
  document: ClusterDocument;
  rootDigest: string;
  manifest: ContractClosureManifest;
  closureDigest: string;
} {
  return buildClusterArtifacts(authClusterDocument());
}

/** The handlers the auth plane supplies, one per {@link ROWS} row. Each receives the serve CONTEXT
 *  (broker-authenticated subject shape beside the validated args); returns the command's output
 *  value (the compiled output contract validates it at the serve boundary). Kept as a narrow
 *  interface so the contract module stays broker-free. */
export interface AuthServiceHandlers {
  roster(ctx: EpServeContext, input: AuthRosterInput): Promise<AuthRosterOutput>;
  retireLifecycle(ctx: EpServeContext): unknown | Promise<unknown>;
  verifyPlacementEnrollment(ctx: EpServeContext): unknown | Promise<unknown>;
  enrollmentEffectStatus(ctx: EpServeContext): unknown | Promise<unknown>;
  closeEnrollmentEffect(ctx: EpServeContext): unknown | Promise<unknown>;
  retirePlacementEnrollment(ctx: EpServeContext): unknown | Promise<unknown>;
}

/** Build the `EpCommandDef[]` `serveEndpoint` consumes. */
export function authCommandDefs(handlers: AuthServiceHandlers): EpCommandDef[] {
  // Reading a pair compiles it (the table is lazy), so a compile failure surfaces here, at
  // registration, where serve needs the validators.
  const dispatch: Record<CommandRow["name"], EpCommandDef["handler"]> = {
    "retire-lifecycle": (ctx) => handlers.retireLifecycle(ctx),
    "verify-placement-enrollment": (ctx) => handlers.verifyPlacementEnrollment(ctx),
    "enrollment-effect-status": (ctx) => handlers.enrollmentEffectStatus(ctx),
    "close-enrollment-effect": (ctx) => handlers.closeEnrollmentEffect(ctx),
    "retire-placement-enrollment": (ctx) => handlers.retirePlacementEnrollment(ctx),
    [AUTH_ROSTER_COMMAND]: (ctx) => {
      const args = ctx.request.args;
      const limit = args?.limit, after = args?.after;
      return handlers.roster(ctx, { ...(typeof limit === "number" ? { limit } : {}), ...(typeof after === "string" ? { after } : {}) });
    },
  };
  return ROWS.map((row) => ({ command: row.name, contract: AUTH_CONTRACTS[row.name], handler: dispatch[row.name] }));
}
