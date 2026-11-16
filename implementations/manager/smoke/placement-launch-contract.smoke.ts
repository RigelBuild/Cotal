/**
 * THE PLACEMENT-ONLY LAUNCH CONTRACT (RIG-10267).
 *
 * The manager serves `prepare-launch` and `place` for the reconciler. The reconciler principal is
 * not built yet (RIG-10330), so the door is wired `configured:false` and these rows refuse. This
 * suite pins what can be proven without it:
 *
 *   (a) both rows ship in the manager cluster document, and the revision is 53;
 *   (b) the new names do not overlap any delegated-user-intent name (SPEC 13.16 stays separate);
 *   (c) each input schema refuses an extra field and a missing required field;
 *   (d) the door refuses `unimplemented` when unconfigured, and `unavailable` when configured with no port;
 *   (e) buildAcceptIntentRequest refuses a claim whose serveEpoch differs from the selected one;
 *   (f) the port's caller comes from the subject, never from the body.
 *
 * Run: pnpm smoke:manager-placement-contract
 */
import {
  buildAcceptIntentRequest, EpEnvelopeError, EP_ENVELOPE_V, EP_RAIL_V1,
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
const DELEGATED_NAMES = ["delegated-user-intent", "manager-delegated-user-intent-execution"] as const;

// (a) both rows ship, and the revision is 53.
console.log("(a) the cluster document declares both rows at revision 53\n");
const shipped = managerShippedSurface();
const docCommands = managerClusterDocument().commands.map((c) => c.name);
check("the shipped revision is 53", shipped.revision === 53, shipped.revision);
for (const name of PLACEMENT_NAMES) check(`${name} is in the shipped surface`, shipped.names.includes(name), shipped.names);
for (const name of PLACEMENT_NAMES) check(`${name} is declared in the cluster document`, docCommands.includes(name), docCommands);

// (b) no overlap with the delegated-user-intent family (SPEC 13.16 stays separate).
console.log("\n(b) the placement names do not overlap a delegated-user-intent name\n");
for (const name of PLACEMENT_NAMES) {
  const overlaps = DELEGATED_NAMES.some((d) => name === d || name.startsWith(d));
  check(`${name} does not overlap a delegated-user-intent name`, !overlaps);
}

// (c) each input schema is closed: an extra field and a missing required field both refuse.
// The compiled input comes from the same table the served validator uses, so this checks the
// registered contract, not a copy of it.
console.log("\n(c) each input schema refuses an extra field and a missing required field\n");
const REQUIRED_KEY: Readonly<Record<(typeof PLACEMENT_NAMES)[number], string>> = { "prepare-launch": "placement", place: "accepted" };
const SAMPLE_ARGS: Readonly<Record<(typeof PLACEMENT_NAMES)[number], Record<string, unknown>>> = {
  "prepare-launch": { placement: {}, entry: {} },
  place: { accepted: {} },
};
for (const name of PLACEMENT_NAMES) {
  const input: CompiledContract = MANAGER_CONTRACTS[name].input;
  const sample = SAMPLE_ARGS[name];
  const withExtra = { ...sample, unexpectedField: 1 };
  const withoutRequired = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== REQUIRED_KEY[name]));
  check(`${name} input refuses an extra field`, input.validate(withExtra) === false);
  check(`${name} input refuses a missing required field`, input.validate(withoutRequired) === false);
}

// (d) the door fails closed in both states.
console.log("\n(d) the door refuses unimplemented when unconfigured and unavailable with no port\n");
const callerSubject = (owner: string, actor: string): EpServeContext["subject"] => ({
  plane: "request", rail: EP_RAIL_V1, route: "one", endpoint: "manager", command: "prepare-launch", target: null,
  caller: { owner, actor, uid: "u".repeat(26) }, nonce: "n".repeat(26),
});
const contextFor = (owner: string, actor: string, args: Record<string, unknown>): EpServeContext => ({
  identity: { endpoint: "manager", instanceId: "i".repeat(26), epoch: 1 },
  subject: callerSubject(owner, actor),
  request: { v: EP_ENVELOPE_V, id: "r".repeat(26), op: { endpoint: "manager", command: "prepare-launch" }, class: "ephemeral", replyExpected: true, deadlineMs: 1000, args },
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
await expectRefusal("unconfigured prepare-launch refuses unimplemented", () => unconfigured.prepareLaunch(contextFor("dev", "reconciler", SAMPLE_ARGS["prepare-launch"])), "unimplemented");
await expectRefusal("unconfigured place refuses unimplemented", () => unconfigured.place(contextFor("dev", "reconciler", SAMPLE_ARGS.place)), "unimplemented");
const configuredNoPort = createPlacementLaunchHandlers({ configured: true, port: () => undefined });
await expectRefusal("configured prepare-launch with no port refuses unavailable", () => configuredNoPort.prepareLaunch(contextFor("dev", "reconciler", SAMPLE_ARGS["prepare-launch"])), "unavailable");
await expectRefusal("configured place with no port refuses unavailable", () => configuredNoPort.place(contextFor("dev", "reconciler", SAMPLE_ARGS.place)), "unavailable");

// (e) accept-intent refuses a claim whose serveEpoch differs from the selected claim.
console.log("\n(e) buildAcceptIntentRequest refuses a claim whose serveEpoch differs from the selected claim\n");
const selected: ManagerClaim = {
  accountPublicKey: `A${"B".repeat(55)}`, instanceId: "a".repeat(26), managerLifecycleUid: "b".repeat(26),
  assignmentRevision: 1, currentRegistrationRevision: 1, serveEpoch: 2,
};
const OPERATION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let staleRefusal: unknown;
try {
  buildAcceptIntentRequest({ operationId: OPERATION_ID, claim: { ...selected, serveEpoch: 1 }, intent: {}, selected });
  staleRefusal = "accepted";
} catch (e) {
  staleRefusal = e instanceof EpEnvelopeError ? e.code : e;
}
check("a claim with a different serveEpoch is refused as bad-request", staleRefusal === "bad-request", staleRefusal);
let equalOperation: string | undefined;
try {
  equalOperation = buildAcceptIntentRequest({ operationId: OPERATION_ID, claim: { ...selected }, intent: {}, selected }).operationId;
} catch (e) {
  equalOperation = e instanceof Error ? e.message : undefined;
}
check("a claim equal to the selected claim is accepted", equalOperation === OPERATION_ID, equalOperation);

// (f) the port's caller comes from the subject, never from the body.
console.log("\n(f) the port's caller comes from the subject, not the body\n");
const recorded: { caller?: string } = {};
const recordingPort: PlacementLaunchPort = {
  prepareLaunch: async (input) => {
    recorded.caller = input.caller;
    return {};
  },
  place: async (input) => {
    recorded.caller = input.caller;
    return {};
  },
};
const spoofedBody = createPlacementLaunchHandlers({ configured: true, port: () => recordingPort });
await spoofedBody.prepareLaunch(contextFor("dev", "reconciler", { ...SAMPLE_ARGS["prepare-launch"], caller: "dev.forged" }));
check("the caller is the subject principal, not the body field", recorded.caller === "dev.reconciler", recorded.caller);

const ok = fail === 0;
console.log(`\nPLACEMENT LAUNCH CONTRACT ${ok ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
