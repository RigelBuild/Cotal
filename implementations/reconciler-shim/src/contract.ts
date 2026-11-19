/**
 * The Cotal endpoint contract for the reconciler's seat commands (`wave-seats`). The catalog is
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
