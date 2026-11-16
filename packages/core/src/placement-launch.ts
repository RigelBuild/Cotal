import { canonicalJson, isContractDigest } from "./canonical-json.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { isAccountNkey } from "./identity.js";
import type { ManagedLifecycleTarget } from "./managed-handoff.js";
import { assertLifecycleToken } from "./subjects.js";

/** The placement-only launch records (RIG-8502 launch protocol § Placement and launch intent). These
 *  are closed: every parser refuses an unknown field, and the field names are the protocol's exactly. */

export interface ManagerClaim {
  accountPublicKey: string;
  instanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  currentRegistrationRevision: number;
  serveEpoch: number;
}

export interface Placement {
  space: "main";
  name: string;
  desiredRevision: number;
  seatRevision: number;
  claim: ManagerClaim;
  generation: number;
  operationId: string;
  workspace: string;
}

export interface ExecutionSubject {
  acceptanceId: string;
  enrollmentOperationId: string;
  phase: "accepted";
}

export interface ExecutionAuthority {
  subject: ExecutionSubject;
  placementOperationId: string;
  intentDigest: string;
  claim: ManagerClaim;
  launchRevision: number;
}

export interface ExecutionGate {
  authority: ExecutionAuthority;
  state: "open" | "closing" | "closed";
  fenceId?: string;
}

export type Window = { kind: "fixed"; seconds: number; anchorUtc: string; timezone: string } | { kind: "rolling"; seconds: number };
export interface Cap {
  usd: number;
  window: Window;
}
type Provider = "claude" | "codex";
type AccountSelection = "shared" | string[];
export type RoutingMap = Partial<Record<Provider, AccountSelection>>;
export interface KeyLimits {
  keyCap?: Cap;
  perModel?: Record<string, { tokens?: number; tpm?: number; rpm?: number }>;
}
export interface KeyRequest {
  routing: RoutingMap;
  limits: KeyLimits;
}
export interface KeySettings extends KeyRequest {
  policyId: string;
}
export interface ProfileSnapshot {
  name: string;
  revision: string;
  configRevision: string;
  modelRoles: Record<string, string>;
  sha256: string;
}
export interface RuntimeAssets {
  revision: string;
  digest: string;
  imageDigest: string;
  baselineConfigDigest: string;
  modelCatalogDigest: string;
  personaCatalogDigest: string;
  extensionsDigest: string;
  rulesSkillsDigest: string;
  cliClosureDigest: string;
  toolBindings: { id: string; endpoint: string; entitlementRef: string }[];
}
export interface HandoffArtifactRef {
  kind: "wave-handoff/v1";
  id: string;
}
export interface HandoffRequest {
  restartOperationId: string;
  name: string;
  predecessorGeneration: number;
  restartGeneration: number;
}
export interface HandoffReceipt {
  receiptId: string;
  request: HandoffRequest;
  lifecycle: ManagedLifecycleTarget;
  artifactRef: HandoffArtifactRef;
  artifactDigest: string;
  sizeBytes: number;
  at: string;
}
export type HandoffInput = { mode: "document"; receipt: HandoffReceipt } | { mode: "none"; reason: "skip" | "not-running" | "superseded" };
export interface LaunchIntent {
  placement: Placement;
  cwd: string;
  workspaceDigest: string;
  persona: string;
  personaDigest: string;
  profile: ProfileSnapshot;
  role: string;
  roleTreeRevision: number;
  assets: RuntimeAssets;
  key: KeySettings;
  policyRevision: number;
  restartGeneration: number;
  handoff?: HandoffInput;
  digest: string;
}
/** Loose by protocol: the observation state is closed but its optional fields are carried as the
 *  reconciler reports them, so the typed shape here is the required core only. */
export interface SeatObservation {
  placement: Placement;
  state: "pending" | "starting" | "running" | "stopping" | "stopped" | "unknown" | "parked";
}
export interface AcceptedIntent {
  acceptanceId: string;
  intent: LaunchIntent;
  acceptedListRevision: number;
  acceptedSeatRevision: number;
  enrollmentOperationId: string;
  executionGate: ExecutionGate;
}

/** The accept-intent request the reconciler's transport sends. The caller's claim must be the
 *  selected manager's claim, so the builder refuses any other. */
export interface AcceptIntentRequest {
  operationId: string;
  claim: ManagerClaim;
  intent: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function fail(what: string, message: string): never { throw new EpEnvelopeError("bad-request", `${what} ${message}`); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], what: string): void {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...expected].sort().join(",")) fail(what, `must contain exactly ${expected.join(", ")}`);
}
function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(what, "must be an object");
  return raw as Record<string, unknown>;
}

/** The ManagerClaim parser, mirrored from placement-enrollment.ts (not exported there). Same shape,
 *  same refusals; keep the two in step. */
function parseClaim(raw: unknown, what: string): ManagerClaim {
  const value = objectOf(raw, what);
  exactKeys(value, ["accountPublicKey", "instanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "serveEpoch"], what);
  if (!isAccountNkey(value.accountPublicKey) || typeof value.instanceId !== "string" || typeof value.managerLifecycleUid !== "string" ||
      !uint(value.assignmentRevision) || !uint(value.currentRegistrationRevision) || !uint(value.serveEpoch)) fail(what, "claim fields are malformed");
  try { assertLifecycleToken(value.instanceId, "manager claim instanceId"); assertLifecycleToken(value.managerLifecycleUid, "manager claim lifecycle uid"); }
  catch { fail(what, "claim lifecycle tokens are malformed"); }
  return { accountPublicKey: value.accountPublicKey, instanceId: value.instanceId, managerLifecycleUid: value.managerLifecycleUid,
    assignmentRevision: value.assignmentRevision, currentRegistrationRevision: value.currentRegistrationRevision, serveEpoch: value.serveEpoch };
}

export function parsePlacement(raw: unknown): Placement {
  const what = "placement";
  const value = objectOf(raw, what);
  exactKeys(value, ["space", "name", "desiredRevision", "seatRevision", "claim", "generation", "operationId", "workspace"], what);
  if (value.space !== "main") fail(what, "space must be main");
  if (typeof value.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value.name)) fail(what, "name is malformed");
  if (!uint(value.desiredRevision) || !uint(value.seatRevision) || !uint(value.generation)) fail(what, "revisions and generation must be unsigned integers");
  if (typeof value.operationId !== "string" || !UUID.test(value.operationId)) fail(what, "operationId must be a UUID");
  if (typeof value.workspace !== "string" || value.workspace.length === 0) fail(what, "workspace is malformed");
  return { space: "main", name: value.name, desiredRevision: value.desiredRevision, seatRevision: value.seatRevision,
    claim: parseClaim(value.claim, `${what} claim`), generation: value.generation, operationId: value.operationId, workspace: value.workspace };
}

function parseSubject(raw: unknown, what: string): ExecutionSubject {
  const value = objectOf(raw, what);
  exactKeys(value, ["acceptanceId", "enrollmentOperationId", "phase"], what);
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) || typeof value.enrollmentOperationId !== "string" ||
      !UUID.test(value.enrollmentOperationId) || value.phase !== "accepted") fail(what, "must identify an accepted enrollment");
  return { acceptanceId: value.acceptanceId, enrollmentOperationId: value.enrollmentOperationId, phase: "accepted" };
}

export function parseExecutionAuthority(raw: unknown): ExecutionAuthority {
  const what = "execution authority";
  const value = objectOf(raw, what);
  exactKeys(value, ["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"], what);
  if (typeof value.placementOperationId !== "string" || !UUID.test(value.placementOperationId) || !isContractDigest(value.intentDigest) ||
      !uint(value.launchRevision) || value.launchRevision < 1) fail(what, "placement, digest, or launch revision is malformed");
  return { subject: parseSubject(value.subject, `${what} subject`), placementOperationId: value.placementOperationId,
    intentDigest: value.intentDigest, claim: parseClaim(value.claim, `${what} claim`), launchRevision: value.launchRevision };
}

export function parseExecutionGate(raw: unknown): ExecutionGate {
  const what = "execution gate";
  const value = objectOf(raw, what);
  const authority = parseExecutionAuthority(value.authority);
  if (value.state !== "open" && value.state !== "closing" && value.state !== "closed") fail(what, "state must be open, closing or closed");
  if (!("fenceId" in value)) {
    exactKeys(value, ["authority", "state"], what);
    return { authority, state: value.state };
  }
  exactKeys(value, ["authority", "state", "fenceId"], what);
  const fenceId = value.fenceId;
  if (typeof fenceId !== "string" || !UUID.test(fenceId)) fail(what, "fenceId must be a UUID");
  return { authority, state: value.state, fenceId };
}

/** Build the accept-intent request. The selected manager is the only caller allowed to send it, so
 *  the claim must equal the selected manager's claim by canonical JSON, and any difference refuses. */
export function buildAcceptIntentRequest(input: {
  operationId: string;
  claim: ManagerClaim;
  intent: unknown;
  selected: ManagerClaim;
}): AcceptIntentRequest {
  if (canonicalJson(input.claim) !== canonicalJson(input.selected))
    fail("accept-intent", "claim must equal the selected manager claim");
  if (typeof input.operationId !== "string" || !UUID.test(input.operationId)) fail("accept-intent", "operationId must be a UUID");
  return { operationId: input.operationId, claim: input.claim, intent: input.intent };
}
