/**
 * THE PLACEMENT-ONLY LAUNCH CONTRACT.
 *
 * The manager serves `prepare-launch` and `place` for the reconciler. The reconciler principal is
 * not built yet, so the door is wired `configured:false` and these rows refuse. This suite pins what
 * can be proven without it:
 *
 *   (a) both rows ship in the manager cluster document, and the revision is 53;
 *   (b) each input and output schema accepts a valid protocol record, including a bound gate, an
 *       observation with `obligations: []`, and a launch intent with `cardRole`;
 *   (c) each input schema refuses one mutated field at a time from the valid fixture, top level and nested;
 *   (d) the door refuses `unimplemented` when unconfigured, and `unavailable` when configured with no port;
 *   (e) buildAcceptIntentRequest derives the claim from the intent and refuses a claim the manager does not hold;
 *   (f) the port's caller comes from the subject, never from the body, for both rows;
 *   (g) the core parsers accept the bound arm and refuse a malformed subject.
 *
 * Run: pnpm smoke:manager-placement-contract
 */
import {
  buildAcceptIntentRequest, EpEnvelopeError, EP_ENVELOPE_V, EP_RAIL_V1,
  parseExecutionAuthority, parseExecutionGate, parsePlacement,
  type CompiledContract, type EpServeContext, type ManagerClaim,
} from "@cotal-ai/core";
import { managerClusterDocument, managerShippedSurface, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { createPlacementLaunchHandlers, type PlacementLaunchPort } from "../src/placement-launch-door.js";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 200)}`}`);
}

const PLACEMENT_NAMES = ["prepare-launch", "place"] as const;
type PlacementName = (typeof PLACEMENT_NAMES)[number];

// One valid protocol fixture. Every later cell derives from it, so a schema that refuses a valid record
// fails here first.
const DIGEST = `sha256:${"c".repeat(64)}`;
const UUID_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UUID_B = "1b2c3d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d";
const UUID_C = "2c3d4e5f-6071-4a8b-8d9e-1f2a3b4c5d6e";
const CLAIM: ManagerClaim = {
  accountPublicKey: `A${"B".repeat(55)}`, instanceId: "a".repeat(26), managerLifecycleUid: "b".repeat(26),
  assignmentRevision: 1, currentRegistrationRevision: 1, serveEpoch: 2,
};
const PLACEMENT = {
  space: "main", name: "dev", desiredRevision: 3, seatRevision: 4, claim: CLAIM, generation: 1,
  operationId: UUID_A, workspace: "ws",
};
const LIFECYCLE = { space: "main", owner: "dev", actor: "dev", lifecycleUid: "c".repeat(26) };
const TARGET = { seatName: "dev", lifecycle: LIFECYCLE, generation: 1 };
const ENTRY = {
  name: "dev", seatRevision: 4, cwd: "/w", tab: "t", state: "active", restartGeneration: 0,
  updatedAt: "2026-11-16T00:00:00Z", profile: "p", role: "r", roleTreeRevision: 1,
  key: { routing: { claude: "shared" }, limits: {}, policyId: "policy" }, workspace: "ws", persona: "persona",
};
const ASSETS = {
  revision: "r1", digest: DIGEST, imageDigest: "sha256:img", baselineConfigDigest: DIGEST, modelCatalogDigest: DIGEST,
  personaCatalogDigest: DIGEST, extensionsDigest: DIGEST, rulesSkillsDigest: DIGEST, cliClosureDigest: DIGEST, toolBindings: [],
};
const INTENT = {
  placement: PLACEMENT, cwd: "/w", workspaceDigest: DIGEST, persona: "persona", personaDigest: DIGEST,
  profile: { name: "p", revision: "1", configRevision: "1", modelRoles: {}, sha256: DIGEST },
  role: "r", roleTreeRevision: 1, assets: ASSETS, key: { routing: {}, limits: {}, policyId: "policy" },
  policyRevision: 1, restartGeneration: 0, digest: DIGEST,
};
const SUBJECT_ACCEPTED = { acceptanceId: UUID_B, enrollmentOperationId: UUID_C, phase: "accepted" };
const SUBJECT_BOUND = { acceptanceId: UUID_B, enrollmentOperationId: UUID_C, phase: "bound", bindingId: UUID_A, target: TARGET };
const AUTHORITY = {
  subject: SUBJECT_ACCEPTED,
  placementOperationId: UUID_A, intentDigest: DIGEST, claim: CLAIM, launchRevision: 1,
};
const GATE_BOUND = { authority: { ...AUTHORITY, subject: SUBJECT_BOUND }, state: "open" };
const OBSERVATION = { placement: PLACEMENT, state: "running", obligations: [] };
const ACCEPTED = {
  acceptanceId: UUID_B, intent: INTENT, acceptedListRevision: 1, acceptedSeatRevision: 4, enrollmentOperationId: UUID_C,
  executionGate: GATE_BOUND,
};

const VALID_INPUT: Readonly<Record<PlacementName, Record<string, unknown>>> = {
  "prepare-launch": { placement: PLACEMENT, entry: ENTRY },
  place: { accepted: ACCEPTED },
};
const REQUIRED_KEY: Readonly<Record<PlacementName, string>> = { "prepare-launch": "placement", place: "accepted" };

// (a) both rows ship, and the revision is 53.
console.log("(a) the cluster document declares both rows at revision 53\n");
const shipped = managerShippedSurface();
const docCommands = managerClusterDocument().commands.map((c) => c.name);
check("the shipped revision is 53", shipped.revision === 53, shipped.revision);
for (const name of PLACEMENT_NAMES) check(`${name} is in the shipped surface`, shipped.names.includes(name), shipped.names);
for (const name of PLACEMENT_NAMES) check(`${name} is declared in the cluster document`, docCommands.includes(name), docCommands);

// (b) a valid protocol record validates on input and output.
console.log("\n(b) a valid protocol record validates on input and output\n");
for (const name of PLACEMENT_NAMES) {
  const input: CompiledContract = MANAGER_CONTRACTS[name].input;
  check(`${name} input accepts a valid record`, input.validate(VALID_INPUT[name]) === true, input.validate.errors);
}
const outputPrepare: CompiledContract = MANAGER_CONTRACTS["prepare-launch"].output;
check("prepare-launch output accepts a launch intent", outputPrepare.validate(INTENT) === true, outputPrepare.validate.errors);
check("prepare-launch output accepts a launch intent carrying cardRole", outputPrepare.validate({ ...INTENT, cardRole: "T7" }) === true, outputPrepare.validate.errors);
const outputPlace: CompiledContract = MANAGER_CONTRACTS.place.output;
check("place output accepts a bound gate and an observation with obligations []",
  outputPlace.validate({ observation: OBSERVATION, executionGate: GATE_BOUND }) === true, outputPlace.validate.errors);
check("place output refuses an observation without obligations",
  outputPlace.validate({ observation: { placement: PLACEMENT, state: "running" }, executionGate: GATE_BOUND }) === false);

// (c) each input refuses one mutated field at a time from the valid fixture.
console.log("\n(c) each input refuses one mutated field at a time\n");
for (const name of PLACEMENT_NAMES) {
  const input: CompiledContract = MANAGER_CONTRACTS[name].input;
  const sample = VALID_INPUT[name];
  const withExtra = { ...sample, unexpectedField: 1 };
  const withoutRequired = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== REQUIRED_KEY[name]));
  check(`${name} input refuses an extra top-level field`, input.validate(withExtra) === false);
  check(`${name} input refuses a missing required top-level field`, input.validate(withoutRequired) === false);
}
const mutatedPlace = (subject: Record<string, unknown>): Record<string, unknown> =>
  ({ accepted: { ...ACCEPTED, executionGate: { ...GATE_BOUND, authority: { ...AUTHORITY, subject } } } });
const placeInput: CompiledContract = MANAGER_CONTRACTS.place.input;
check("place refuses a subject whose phase is neither accepted nor bound", placeInput.validate(mutatedPlace({ ...SUBJECT_BOUND, phase: "other" })) === false);
check("place refuses a bound subject with no target",
  placeInput.validate(mutatedPlace(Object.fromEntries(Object.entries(SUBJECT_BOUND).filter(([key]) => key !== "target")))) === false);
check("place refuses a bound subject whose target has an extra field",
  placeInput.validate(mutatedPlace({ ...SUBJECT_BOUND, target: { ...TARGET, extra: 1 } })) === false);
const prepareInput: CompiledContract = MANAGER_CONTRACTS["prepare-launch"].input;
check("prepare-launch refuses an extra field nested in placement",
  prepareInput.validate({ ...VALID_INPUT["prepare-launch"], placement: { ...PLACEMENT, extra: 1 } }) === false);
check("prepare-launch refuses an entry with no key settings",
  prepareInput.validate({ ...VALID_INPUT["prepare-launch"], entry: Object.fromEntries(Object.entries(ENTRY).filter(([key]) => key !== "key")) }) === false);

// (d) the door fails closed in both states.
console.log("\n(d) the door refuses unimplemented when unconfigured and unavailable with no port\n");
const contextFor = (owner: string, actor: string, command: PlacementName, args: Record<string, unknown>): EpServeContext => ({
  identity: { endpoint: "manager", instanceId: "i".repeat(26), epoch: 1 },
  subject: {
    plane: "request", rail: EP_RAIL_V1, route: "one", endpoint: "manager", command, target: null,
    caller: { owner, actor, uid: "u".repeat(26) }, nonce: "n".repeat(26),
  },
  request: { v: EP_ENVELOPE_V, id: "r".repeat(26), op: { endpoint: "manager", command }, class: "ephemeral", replyExpected: true, deadlineMs: 1000, args },
});
const expectRefusal = async (label: string, run: () => Promise<unknown>, code: string): Promise<void> => {
  try {
    await run();
    check(label, false, "resolved without refusing");
  } catch (e) {
    check(label, e instanceof EpEnvelopeError && e.code === code, e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
};
const unconfigured = createPlacementLaunchHandlers({ configured: false, port: () => undefined });
await expectRefusal("unconfigured prepare-launch refuses unimplemented", () => unconfigured.prepareLaunch(contextFor("dev", "reconciler", "prepare-launch", VALID_INPUT["prepare-launch"])), "unimplemented");
await expectRefusal("unconfigured place refuses unimplemented", () => unconfigured.place(contextFor("dev", "reconciler", "place", VALID_INPUT.place)), "unimplemented");
const configuredNoPort = createPlacementLaunchHandlers({ configured: true, port: () => undefined });
await expectRefusal("configured prepare-launch with no port refuses unavailable", () => configuredNoPort.prepareLaunch(contextFor("dev", "reconciler", "prepare-launch", VALID_INPUT["prepare-launch"])), "unavailable");
await expectRefusal("configured place with no port refuses unavailable", () => configuredNoPort.place(contextFor("dev", "reconciler", "place", VALID_INPUT.place)), "unavailable");

// (e) buildAcceptIntentRequest derives the claim from the intent and refuses a claim the manager does not hold.
console.log("\n(e) buildAcceptIntentRequest derives the claim from the intent and refuses a foreign claim\n");
const OPERATION_ID = UUID_A;
const accepted = buildAcceptIntentRequest({ operationId: OPERATION_ID, intent: INTENT, current: CLAIM });
check("an intent whose placement claim matches the current claim is accepted", accepted.operationId === OPERATION_ID && accepted.claim.serveEpoch === CLAIM.serveEpoch);
const refuseCode = (run: () => unknown): unknown => {
  try { run(); return "accepted"; } catch (e) { return e instanceof EpEnvelopeError ? e.code : e; }
};
check("an intent whose claim has a different serveEpoch than the current claim is refused as bad-request",
  refuseCode(() => buildAcceptIntentRequest({ operationId: OPERATION_ID, intent: INTENT, current: { ...CLAIM, serveEpoch: 1 } })) === "bad-request");
check("an intent with an unknown field is refused as bad-request",
  refuseCode(() => buildAcceptIntentRequest({ operationId: OPERATION_ID, intent: { ...INTENT, extra: 1 }, current: CLAIM })) === "bad-request");

// (f) the port's caller comes from the subject, never from the body, for both rows.
console.log("\n(f) the port's caller comes from the subject, not the body, for both rows\n");
const recorded: { caller?: string } = {};
const recordingPort: PlacementLaunchPort = {
  prepareLaunch: async (input) => { recorded.caller = input.caller; return {}; },
  place: async (input) => { recorded.caller = input.caller; return {}; },
};
const spoofed = createPlacementLaunchHandlers({ configured: true, port: () => recordingPort });
await spoofed.prepareLaunch(contextFor("dev", "reconciler", "prepare-launch", { ...VALID_INPUT["prepare-launch"], caller: "dev.forged" }));
check("prepare-launch: the caller is the subject principal, not the body field", recorded.caller === "dev.reconciler", recorded.caller);
await spoofed.place(contextFor("dev", "reconciler", "place", { ...VALID_INPUT.place, caller: "dev.forged" }));
check("place: the caller is the subject principal, not the body field", recorded.caller === "dev.reconciler", recorded.caller);

// (g) the core parsers accept the bound arm and refuse a malformed subject.
console.log("\n(g) the core parsers accept the bound arm and refuse a malformed subject\n");
check("parsePlacement accepts a valid placement", parsePlacement(PLACEMENT).name === "dev");
check("parseExecutionAuthority accepts the bound arm", parseExecutionAuthority(GATE_BOUND.authority).subject.phase === "bound");
check("parseExecutionGate accepts the bound gate", parseExecutionGate(GATE_BOUND).state === "open");
check("parseExecutionAuthority refuses a bound subject with no target",
  refuseCode(() => parseExecutionAuthority({ ...AUTHORITY, subject: { acceptanceId: UUID_B, enrollmentOperationId: UUID_C, phase: "bound", bindingId: UUID_A } })) === "bad-request");
check("parseExecutionAuthority refuses an unknown phase",
  refuseCode(() => parseExecutionAuthority({ ...AUTHORITY, subject: { ...SUBJECT_ACCEPTED, phase: "other" } })) === "bad-request");

const ok = fail === 0;
console.log(`\nPLACEMENT LAUNCH CONTRACT ${ok ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
