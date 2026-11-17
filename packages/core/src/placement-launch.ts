import { canonicalJson, isContractDigest } from "./canonical-json.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { isAccountNkey } from "./identity.js";
import type { ManagedLifecycleTarget } from "./managed-handoff.js";
import { assertLifecycleToken } from "./subjects.js";

/** The placement-only launch records (launch protocol § Placement and launch intent, § Execution
 *  admission and launch fence). These are closed: every parser refuses an unknown field, and the field
 *  names are the protocol's exactly. */

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

/** The protocol's `AgentKeyTarget`: the seat, its lifecycle and its generation. */
export interface AgentKeyTarget {
  seatName: string;
  lifecycle: ManagedLifecycleTarget;
  generation: number;
}

/** The accepted arm exists before binding. The bound arm exists after `bind-enrollment` verifies the
 *  binding. The gate carries whichever arm is current, so replay never returns a stale subject. */
export type ExecutionSubject =
  | { acceptanceId: string; enrollmentOperationId: string; phase: "accepted" }
  | { acceptanceId: string; enrollmentOperationId: string; phase: "bound"; bindingId: string; target: AgentKeyTarget };

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
  cardRole?: string;
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

/** The reconciler's `KeyObservation`, filled from authenticated gateway state. */
export interface KeyObservation {
  desiredAuthorizationRevision: number;
  appliedAuthorizationRevision?: number;
  settingsRevision?: number;
  operationId?: string;
  condition: "effective" | "pending" | "unknown" | "rejected";
  observedAt: string;
}

/** One open obligation on a seat generation (§ Retirement obligations). */
export interface RetirementObligation {
  obligationId: string;
  name: string;
  generation: number;
  reason: "pause" | "remove" | "replace";
  committedRevision: number;
  state: "pending" | "unknown" | "terminal";
  deathProofId?: string;
  keyDenialProofId?: string;
}

export interface CleanupStep {
  kind: "push" | "handoff" | "archive" | "pvc-delete";
  state: "pending" | "unknown" | "done" | "parked";
  attemptId?: string;
  proofId?: string;
  reason?: string;
}

/** The seat's data cleanup after `remove` (§ Seat data cleanup after remove). */
export interface SeatDataCleanup {
  name: string;
  retiredRevision: number;
  state: "pending" | "parked" | "done";
  steps: CleanupStep[];
}

export interface SeatObservation {
  placement: Placement;
  lifecycle?: ManagedLifecycleTarget;
  state: "pending" | "starting" | "running" | "stopping" | "stopped" | "unknown" | "parked";
  executionIdentity?: string;
  keyId?: string;
  reason?: string;
  key?: KeyObservation;
  obligations: RetirementObligation[];
  cleanup?: SeatDataCleanup;
}

export interface AcceptedIntent {
  acceptanceId: string;
  intent: LaunchIntent;
  acceptedListRevision: number;
  acceptedSeatRevision: number;
  enrollmentOperationId: string;
  executionGate: ExecutionGate;
}

/** The accept-intent request the reconciler's transport sends. `claim` is taken from the intent's own
 *  `placement.claim`; `buildAcceptIntentRequest` refuses unless it equals the manager's current claim. */
export interface AcceptIntentRequest {
  operationId: string;
  claim: ManagerClaim;
  intent: LaunchIntent;
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

/** Parse one `ManagerClaim` (§ Placement and launch intent). Shared with `placement-enrollment.ts`. */
export function parseManagerClaim(raw: unknown, what = "manager claim"): ManagerClaim {
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
    claim: parseManagerClaim(value.claim, `${what} claim`), generation: value.generation, operationId: value.operationId, workspace: value.workspace };
}

function parseManagedLifecycleTarget(raw: unknown, what: string): ManagedLifecycleTarget {
  const value = objectOf(raw, what);
  exactKeys(value, ["space", "owner", "actor", "lifecycleUid"], what);
  if (typeof value.space !== "string" || value.space.length === 0 || typeof value.owner !== "string" || value.owner.length === 0 ||
      typeof value.actor !== "string" || value.actor.length === 0 || typeof value.lifecycleUid !== "string") fail(what, "lifecycle target is malformed");
  try { assertLifecycleToken(value.lifecycleUid, `${what} lifecycleUid`); }
  catch { fail(what, "lifecycle target uid is malformed"); }
  return { space: value.space, owner: value.owner, actor: value.actor, lifecycleUid: value.lifecycleUid };
}

function parseAgentKeyTarget(raw: unknown, what: string): AgentKeyTarget {
  const value = objectOf(raw, what);
  exactKeys(value, ["seatName", "lifecycle", "generation"], what);
  if (typeof value.seatName !== "string" || value.seatName.length === 0 || !uint(value.generation)) fail(what, "seat name or generation is malformed");
  return { seatName: value.seatName, lifecycle: parseManagedLifecycleTarget(value.lifecycle, `${what} lifecycle`), generation: value.generation };
}

/** Parse an `ExecutionSubject`. Both arms are valid: `accepted` before binding, `bound` after. */
function parseSubject(raw: unknown, what: string): ExecutionSubject {
  const value = objectOf(raw, what);
  if (typeof value.acceptanceId !== "string" || !UUID.test(value.acceptanceId) || typeof value.enrollmentOperationId !== "string" ||
      !UUID.test(value.enrollmentOperationId)) fail(what, "must identify an enrollment by UUID ids");
  if (value.phase === "accepted") {
    exactKeys(value, ["acceptanceId", "enrollmentOperationId", "phase"], what);
    return { acceptanceId: value.acceptanceId, enrollmentOperationId: value.enrollmentOperationId, phase: "accepted" };
  }
  if (value.phase === "bound") {
    exactKeys(value, ["acceptanceId", "enrollmentOperationId", "phase", "bindingId", "target"], what);
    if (typeof value.bindingId !== "string" || !UUID.test(value.bindingId)) fail(what, "bindingId must be a UUID");
    return { acceptanceId: value.acceptanceId, enrollmentOperationId: value.enrollmentOperationId, phase: "bound",
      bindingId: value.bindingId, target: parseAgentKeyTarget(value.target, `${what} target`) };
  }
  return fail(what, "phase must be accepted or bound");
}

/** Parse an `ExecutionAuthority`. Shared with `placement-enrollment.ts`. */
export function parseExecutionAuthority(raw: unknown, what = "execution authority"): ExecutionAuthority {
  const value = objectOf(raw, what);
  exactKeys(value, ["subject", "placementOperationId", "intentDigest", "claim", "launchRevision"], what);
  if (typeof value.placementOperationId !== "string" || !UUID.test(value.placementOperationId) || !isContractDigest(value.intentDigest) ||
      !uint(value.launchRevision) || value.launchRevision < 1) fail(what, "placement, digest, or launch revision is malformed");
  return { subject: parseSubject(value.subject, `${what} subject`), placementOperationId: value.placementOperationId,
    intentDigest: value.intentDigest, claim: parseManagerClaim(value.claim, `${what} claim`), launchRevision: value.launchRevision };
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

/** Build the accept-intent request. The intent is parsed with the closed `LaunchIntent` shape. The claim
 *  is taken from the intent's own `placement.claim` and must equal the manager's `current` claim. Any
 *  difference refuses. This builder does not authenticate the caller. The transport that authenticates
 *  the selected manager is not built yet (tracked by the reconciler principal work). */
export function buildAcceptIntentRequest(input: {
  operationId: string;
  intent: unknown;
  current: ManagerClaim;
}): AcceptIntentRequest {
  if (typeof input.operationId !== "string" || !UUID.test(input.operationId)) fail("accept-intent", "operationId must be a UUID");
  const intent = parseLaunchIntent(input.intent);
  const claim = intent.placement.claim;
  const current = parseManagerClaim(input.current, "accept-intent current claim");
  if (canonicalJson(claim) !== canonicalJson(current)) fail("accept-intent", "intent placement claim must equal the manager's current claim");
  return { operationId: input.operationId, claim, intent };
}

/** Parse a closed `LaunchIntent`. Used by `buildAcceptIntentRequest` before it binds the claim. */
function parseLaunchIntent(raw: unknown): LaunchIntent {
  const what = "launch intent";
  const value = objectOf(raw, what);
  const keys = ["placement", "cwd", "workspaceDigest", "persona", "personaDigest", "profile", "role", "roleTreeRevision", "assets", "key", "policyRevision", "restartGeneration", "digest"];
  const allowed = [...keys, "cardRole", "handoff"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(what, `has unknown field ${key}`);
  for (const key of keys) if (!(key in value)) fail(what, `is missing ${key}`);
  if (typeof value.cwd !== "string" || value.cwd.length === 0 || !isContractDigest(value.workspaceDigest) ||
      typeof value.persona !== "string" || value.persona.length === 0 || !isContractDigest(value.personaDigest) ||
      typeof value.role !== "string" || value.role.length === 0 || !uint(value.roleTreeRevision) || !uint(value.policyRevision) ||
      !uint(value.restartGeneration) || !isContractDigest(value.digest)) fail(what, "scalar fields are malformed");
  if ("cardRole" in value && (typeof value.cardRole !== "string" || value.cardRole.length === 0)) fail(what, "cardRole must be a non-empty string");
  const cardRole = typeof value.cardRole === "string" ? { cardRole: value.cardRole } : {};
  return {
    placement: parsePlacement(value.placement),
    cwd: value.cwd,
    workspaceDigest: value.workspaceDigest,
    persona: value.persona,
    personaDigest: value.personaDigest,
    ...cardRole,
    profile: parseProfileSnapshot(value.profile, `${what} profile`),
    role: value.role,
    roleTreeRevision: value.roleTreeRevision,
    assets: parseRuntimeAssets(value.assets, `${what} assets`),
    key: parseKeySettings(value.key, `${what} key`),
    policyRevision: value.policyRevision,
    restartGeneration: value.restartGeneration,
    ...("handoff" in value ? { handoff: parseHandoffInput(value.handoff, `${what} handoff`) } : {}),
    digest: value.digest,
  };
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseProfileSnapshot(raw: unknown, what: string): ProfileSnapshot {
  const value = objectOf(raw, what);
  exactKeys(value, ["name", "revision", "configRevision", "modelRoles", "sha256"], what);
  if (!isString(value.name) || !isString(value.revision) || !isString(value.configRevision) || !isContractDigest(value.sha256)) fail(what, "fields are malformed");
  const roles = objectOf(value.modelRoles, `${what} modelRoles`);
  const modelRoles: Record<string, string> = {};
  for (const [role, model] of Object.entries(roles)) {
    if (!isString(model)) fail(what, "modelRoles values must be non-empty strings");
    modelRoles[role] = model;
  }
  return { name: value.name, revision: value.revision, configRevision: value.configRevision, modelRoles, sha256: value.sha256 };
}

function parseRuntimeAssets(raw: unknown, what: string): RuntimeAssets {
  const value = objectOf(raw, what);
  exactKeys(value, ["revision", "digest", "imageDigest", "baselineConfigDigest", "modelCatalogDigest", "personaCatalogDigest", "extensionsDigest", "rulesSkillsDigest", "cliClosureDigest", "toolBindings"], what);
  if (!isString(value.revision) || !isString(value.imageDigest) || !Array.isArray(value.toolBindings)) fail(what, "fields are malformed");
  if (!isContractDigest(value.digest) || !isContractDigest(value.baselineConfigDigest) || !isContractDigest(value.modelCatalogDigest) ||
      !isContractDigest(value.personaCatalogDigest) || !isContractDigest(value.extensionsDigest) || !isContractDigest(value.rulesSkillsDigest) ||
      !isContractDigest(value.cliClosureDigest)) fail(what, "digest fields are malformed");
  const toolBindings = value.toolBindings.map((entry: unknown, index: number) => {
    const binding = objectOf(entry, `${what} toolBindings[${index}]`);
    exactKeys(binding, ["id", "endpoint", "entitlementRef"], `${what} toolBindings[${index}]`);
    if (!isString(binding.id) || !isString(binding.endpoint) || !isString(binding.entitlementRef)) fail(what, "toolBindings entries are malformed");
    return { id: binding.id, endpoint: binding.endpoint, entitlementRef: binding.entitlementRef };
  });
  return { revision: value.revision, digest: value.digest, imageDigest: value.imageDigest,
    baselineConfigDigest: value.baselineConfigDigest, modelCatalogDigest: value.modelCatalogDigest,
    personaCatalogDigest: value.personaCatalogDigest, extensionsDigest: value.extensionsDigest,
    rulesSkillsDigest: value.rulesSkillsDigest, cliClosureDigest: value.cliClosureDigest, toolBindings };
}

function parseHandoffInput(raw: unknown, what: string): HandoffInput {
  const value = objectOf(raw, what);
  if (value.mode === "none") {
    exactKeys(value, ["mode", "reason"], what);
    if (value.reason !== "skip" && value.reason !== "not-running" && value.reason !== "superseded") fail(what, "reason is malformed");
    return { mode: "none", reason: value.reason };
  }
  if (value.mode !== "document") fail(what, "mode must be document or none");
  exactKeys(value, ["mode", "receipt"], what);
  const receipt = objectOf(value.receipt, `${what} receipt`);
  exactKeys(receipt, ["receiptId", "request", "lifecycle", "artifactRef", "artifactDigest", "sizeBytes", "at"], `${what} receipt`);
  const request = objectOf(receipt.request, `${what} receipt request`);
  exactKeys(request, ["restartOperationId", "name", "predecessorGeneration", "restartGeneration"], `${what} receipt request`);
  const artifactRef = objectOf(receipt.artifactRef, `${what} receipt artifactRef`);
  exactKeys(artifactRef, ["kind", "id"], `${what} receipt artifactRef`);
  if (typeof receipt.receiptId !== "string" || !UUID.test(receipt.receiptId) || typeof request.restartOperationId !== "string" ||
      !UUID.test(request.restartOperationId) || !isString(request.name) || !uint(request.predecessorGeneration) || !uint(request.restartGeneration) ||
      artifactRef.kind !== "wave-handoff/v1" || typeof artifactRef.id !== "string" || !UUID.test(artifactRef.id) ||
      !isContractDigest(receipt.artifactDigest) || !uint(receipt.sizeBytes) || !isString(receipt.at)) fail(what, "receipt fields are malformed");
  return { mode: "document", receipt: {
    receiptId: receipt.receiptId,
    request: { restartOperationId: request.restartOperationId, name: request.name, predecessorGeneration: request.predecessorGeneration, restartGeneration: request.restartGeneration },
    lifecycle: parseManagedLifecycleTarget(receipt.lifecycle, `${what} receipt lifecycle`),
    artifactRef: { kind: "wave-handoff/v1", id: artifactRef.id },
    artifactDigest: receipt.artifactDigest, sizeBytes: receipt.sizeBytes, at: receipt.at,
  } };
}

function parseKeySettings(raw: unknown, what: string): KeySettings {
  const value = objectOf(raw, what);
  exactKeys(value, ["routing", "limits", "policyId"], what);
  if (!isString(value.policyId)) fail(what, "policyId must be a non-empty string");
  return { routing: parseRoutingMap(value.routing, `${what} routing`), limits: parseKeyLimits(value.limits, `${what} limits`), policyId: value.policyId };
}

const isProvider = (value: string): value is Provider => value === "claude" || value === "codex";

function parseRoutingMap(raw: unknown, what: string): RoutingMap {
  const value = objectOf(raw, what);
  const routing: RoutingMap = {};
  for (const key of Object.keys(value)) {
    if (!isProvider(key)) fail(what, `has unknown provider ${key}`);
    const selection = value[key];
    if (selection === "shared") routing[key] = "shared";
    else if (Array.isArray(selection) && selection.every(isString)) routing[key] = selection;
    else fail(what, `${key} must be shared or a list of account ids`);
  }
  return routing;
}

function parseKeyLimits(raw: unknown, what: string): KeyLimits {
  const value = objectOf(raw, what);
  for (const key of Object.keys(value)) if (key !== "keyCap" && key !== "perModel") fail(what, `has unknown field ${key}`);
  const limits: KeyLimits = {};
  if (value.keyCap !== undefined) limits.keyCap = parseCap(value.keyCap, `${what} keyCap`);
  if (value.perModel !== undefined) {
    const perModel = objectOf(value.perModel, `${what} perModel`);
    const models: NonNullable<KeyLimits["perModel"]> = {};
    for (const [model, entry] of Object.entries(perModel)) models[model] = parseModelCounts(entry, `${what} perModel.${model}`);
    limits.perModel = models;
  }
  return limits;
}

function parseModelCounts(raw: unknown, what: string): { tokens?: number; tpm?: number; rpm?: number } {
  const value = objectOf(raw, what);
  for (const key of Object.keys(value)) if (key !== "tokens" && key !== "tpm" && key !== "rpm") fail(what, `has unknown field ${key}`);
  const counts: { tokens?: number; tpm?: number; rpm?: number } = {};
  const { tokens, tpm, rpm } = value;
  if (tokens !== undefined) { if (!uint(tokens)) fail(what, "tokens must be an unsigned integer"); counts.tokens = tokens; }
  if (tpm !== undefined) { if (!uint(tpm)) fail(what, "tpm must be an unsigned integer"); counts.tpm = tpm; }
  if (rpm !== undefined) { if (!uint(rpm)) fail(what, "rpm must be an unsigned integer"); counts.rpm = rpm; }
  return counts;
}

function parseCap(raw: unknown, what: string): Cap {
  const value = objectOf(raw, what);
  exactKeys(value, ["usd", "window"], what);
  if (typeof value.usd !== "number" || !Number.isFinite(value.usd) || value.usd < 0) fail(what, "usd must be a non-negative number");
  const window = objectOf(value.window, `${what} window`);
  if (window.kind === "fixed") {
    exactKeys(window, ["kind", "seconds", "anchorUtc", "timezone"], `${what} window`);
    if (!uint(window.seconds) || !isString(window.anchorUtc) || !isString(window.timezone)) fail(what, "fixed window fields are malformed");
    return { usd: value.usd, window: { kind: "fixed", seconds: window.seconds, anchorUtc: window.anchorUtc, timezone: window.timezone } };
  }
  if (window.kind === "rolling") {
    exactKeys(window, ["kind", "seconds"], `${what} window`);
    if (!uint(window.seconds)) fail(what, "rolling window seconds must be an unsigned integer");
    return { usd: value.usd, window: { kind: "rolling", seconds: window.seconds } };
  }
  return fail(what, "window kind must be fixed or rolling");
}
