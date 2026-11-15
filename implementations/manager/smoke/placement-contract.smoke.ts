import { EpEnvelopeError, DEV_OWNER, type AcceptedIntent, type EpCommandDef, type EpServeContext, type Placement, type SeatEntryV2 } from "@cotal-ai/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, managerClusterDocument } from "../src/manager-service-contract.js";
import type { PlacementAuthorityCallbacks, SeatObservation } from "../src/placement/service.js";

const names = ["place", "observe", "stop-placement", "prepare-launch", "profile-get"];
for (const name of names) {
  if (!managerClusterDocument().commands.some((row) => row.name === name) || !MANAGER_CONTRACTS[name]) {
    throw new Error(`missing placement command ${name}`);
  }
}
const observe = MANAGER_CONTRACTS.observe;
if (!observe.input.validate({ name: "seat", generation: 1 }) ||
    observe.input.validate({ name: "seat", generation: 1, claim: {} }) ||
    observe.output.validate({ state: "running" })) {
  throw new Error("observe contract did not enforce its closed request and required response");
}
const profile = MANAGER_CONTRACTS["profile-get"];
if (!profile.input.validate({ name: "default" }) || profile.input.validate({ name: "default", path: "/tmp/roles" }) ||
    profile.output.validate({ name: "default" })) {
  throw new Error("profile contract accepted a caller path or incomplete response");
}
const root = mkdtempSync(join(tmpdir(), "cotal-placement-contract-"));
try {
  const snapshot = { name: "default", revision: "r1", configRevision: "c1", modelRoles: { default: "provider/model" }, sha256: "a".repeat(64) };
  const requested: string[] = [];
  const observed: Parameters<PlacementAuthorityCallbacks["observe"]>[0][] = [];
  const placement: Placement = {
    space: "main" as const,
    name: "seat",
    desiredRevision: 4,
    seatRevision: 3,
    claim: {
      accountPublicKey: "account",
      instanceId: "manager",
      managerLifecycleUid: "00112233445566778899aabbccddeeff",
      assignmentRevision: 2,
      currentRegistrationRevision: 5,
      serveEpoch: 6,
    },
    generation: 7,
    operationId: "ffeeddccbbaa99887766554433221100",
    workspace: "workspace",
  };
  const digest = "a".repeat(64);
  const accepted: AcceptedIntent = {
    acceptanceId: "11111111111111111111111111111111",
    intent: {
      placement,
      cwd: "/workspace/seat",
      workspaceDigest: digest,
      persona: "worker",
      personaDigest: digest,
      profile: { name: "default", revision: "r1", configRevision: "c1", modelRoles: { default: "provider/model" }, sha256: digest },
      role: "worker",
      roleTreeRevision: 1,
      assets: { revision: "r1", digest, imageDigest: digest, baselineConfigDigest: digest, modelCatalogDigest: digest, personaCatalogDigest: digest, extensionsDigest: digest, rulesSkillsDigest: digest, cliClosureDigest: digest, toolBindings: [] },
      key: { routing: {}, limits: {}, policyId: "policy" },
      policyRevision: 1,
      restartGeneration: 7,
      digest,
    },
    acceptedListRevision: 4,
    acceptedSeatRevision: 3,
    enrollmentOperationId: "22222222222222222222222222222222",
    executionGate: {
      authority: { subject: { acceptanceId: "11111111111111111111111111111111", enrollmentOperationId: "22222222222222222222222222222222", phase: "accepted" }, placementOperationId: placement.operationId, intentDigest: digest, claim: placement.claim, launchRevision: 1 },
      state: "open",
    },
  };
  const entry: SeatEntryV2 = {
    name: "seat", seatRevision: 3, cwd: "/workspace/seat", tab: "seat", state: "active", restartGeneration: 7,
    updatedAt: "2026-11-15T00:00:00Z", profile: "default", role: "worker", roleTreeRevision: 1,
    key: { routing: {}, limits: {}, policyId: "policy" }, workspace: "workspace", persona: "worker",
  };
  const observation: SeatObservation = { placement, state: "running", obligations: [] };
  const prepareLaunchCalls: Parameters<PlacementAuthorityCallbacks["prepareLaunch"]>[0][] = [];
  const placeCalls: Parameters<PlacementAuthorityCallbacks["place"]>[0][] = [];
  const stopPlacementCalls: Parameters<PlacementAuthorityCallbacks["stopPlacement"]>[0][] = [];
  const callbackFailure = new Error("callback reached");
  const placementAuthority: PlacementAuthorityCallbacks = {
    prepareLaunch: async (args) => { prepareLaunchCalls.push(args); throw callbackFailure; },
    place: async (args) => { placeCalls.push(args); throw callbackFailure; },
    observe: async (args) => { observed.push(args); return observation; },
    stopPlacement: async (args) => { stopPlacementCalls.push(args); throw callbackFailure; },
  };
  const reconcilerUid = "00112233445566778899aabbccddeeff";
  const authorizePlacement = (ctx: EpServeContext) =>
    ctx.subject.caller.owner === DEV_OWNER && ctx.subject.caller.uid === reconcilerUid;
  const manager = new Manager({ space: "main", runtime: "pty", workspaceRoot: root, authorizePlacement, profileGet: async (name) => { requested.push(name); return snapshot; }, placementAuthority });
  const absent = new Manager({ space: "main", runtime: "pty", workspaceRoot: root, authorizePlacement });
  const noAuthorizer = new Manager({ space: "main", runtime: "pty", workspaceRoot: root });
  const throwingAuthorizer = new Manager({ space: "main", runtime: "pty", workspaceRoot: root, authorizePlacement: () => { throw new Error("authority unavailable"); } });
  // This test reaches the private service table without starting the broker.
  const managerSeam = manager as unknown as { managerServiceDefs(): EpCommandDef[] };
  const absentSeam = absent as unknown as { managerServiceDefs(): EpCommandDef[] };
  const noAuthorizerSeam = noAuthorizer as unknown as { managerServiceDefs(): EpCommandDef[] };
  const throwingSeam = throwingAuthorizer as unknown as { managerServiceDefs(): EpCommandDef[] };
  const managerDefs = managerSeam.managerServiceDefs();
  const absentDefs = absentSeam.managerServiceDefs();
  const noAuthorizerDefs = noAuthorizerSeam.managerServiceDefs();
  const throwingDefs = throwingSeam.managerServiceDefs();
  const context = (command: string, actor = "reconciler", args: Record<string, unknown> = { name: "default" }, callerUid = actor === "reconciler" ? reconcilerUid : "ffeeddccbbaa99887766554433221100"): EpServeContext => ({
    identity: { endpoint: "manager", instanceId: "manager", epoch: 1 },
    subject: { plane: "request", route: "one", endpoint: "manager", command, target: null,
      caller: { owner: DEV_OWNER, actor, uid: callerUid }, nonce: "ffeeddccbbaa99887766554433221100" },
    request: { v: 1, id: "ffeeddccbbaa99887766554433221100", args } as unknown as EpServeContext["request"],
  });
  const handler = (defs: EpCommandDef[], command: string) => {
    const def = defs.find((row) => row.command === command);
    if (!def) throw new Error(`missing handler ${command}`);
    return def.handler;
  };
  const profileContext = context("profile-get");
  const actual = await handler(managerDefs, "profile-get")(profileContext);
  if (actual !== snapshot || requested.length !== 1 || requested[0] !== "default" || !profile.output.validate(actual)) throw new Error("trusted profile callback result was not served");
  const observeContext = context("observe", "reconciler", { name: "seat", generation: 7 });
  const observedResult = await handler(managerDefs, "observe")(observeContext);
  if (observedResult !== observation || !observe.output.validate(observedResult) || observed.length !== 1 || observed[0].name !== "seat" || observed[0].generation !== 7 || observed[0].caller !== observeContext.subject.caller)
    throw new Error("observe did not pass the requested generation and authenticated caller to retained state");
  let stale: unknown;
  try { await handler(managerDefs, "observe")(context("observe", "reconciler", { name: "seat", generation: 6 })); } catch (error) { stale = error; }
  if (!(stale instanceof EpEnvelopeError) || stale.code !== "expired" || observed.length !== 2 || observed[1].generation !== 6)
    throw new Error("observe relabeled a retained stale generation instead of refusing it", { cause: stale });
  for (const [command, args, calls] of [
    ["prepare-launch", { placement, entry }, prepareLaunchCalls],
    ["place", { accepted }, placeCalls],
    ["stop-placement", { placement }, stopPlacementCalls],
  ] as const) {
    const callContext = context(command, "reconciler", args);
    let failure: unknown;
    try { await handler(managerDefs, command)(callContext); } catch (error) { failure = error; }
    const payloadMatches = command === "prepare-launch"
      ? prepareLaunchCalls[0]?.placement === placement && prepareLaunchCalls[0]?.entry === entry
      : command === "place"
        ? placeCalls[0]?.accepted === accepted
        : stopPlacementCalls[0]?.placement === placement;
    if (failure !== callbackFailure || calls.length !== 1 || calls[0]?.caller !== callContext.subject.caller || !payloadMatches)
      throw new Error(`${command} did not pass its validated request and authenticated caller to the trusted callback`, { cause: failure });
  }
  for (const command of names) {
    let denied: unknown;
    try { await handler(managerDefs, command)(context(command, "operator")); } catch (error) { denied = error; }
    if (!(denied instanceof EpEnvelopeError) || denied.code !== "permission-denied") throw new Error(`${command} admitted a different authenticated principal`, { cause: denied });
  }
  let spoofed: unknown;
  try { await handler(managerDefs, "profile-get")(context("profile-get", "reconciler", { name: "default" }, "ffeeddccbbaa99887766554433221100")); } catch (error) { spoofed = error; }
  if (!(spoofed instanceof EpEnvelopeError) || spoofed.code !== "permission-denied" || requested.length !== 1)
    throw new Error("actor label spoof with a different authenticated lifecycle reached the trusted profile callback", { cause: spoofed });
  if (requested.length !== 1 || observed.length !== 2 || prepareLaunchCalls.length !== 1 || placeCalls.length !== 1 || stopPlacementCalls.length !== 1)
    throw new Error("unauthorized caller reached a placement callback");
  for (const command of names) {
    let failure: unknown;
    try { await handler(noAuthorizerDefs, command)(context(command)); } catch (error) { failure = error; }
    if (!(failure instanceof EpEnvelopeError) || failure.code !== "permission-denied") throw new Error(`${command} admitted without an authorizer`, { cause: failure });
    let thrown: unknown;
    try { await handler(throwingDefs, command)(context(command)); } catch (error) { thrown = error; }
    if (!(thrown instanceof EpEnvelopeError) || thrown.code !== "permission-denied") throw new Error(`${command} did not fail closed when authorization threw`, { cause: thrown });
  }
  for (const command of names) {
    let failure: unknown;
    try { await handler(absentDefs, command)(context(command)); } catch (error) { failure = error; }
    if (!(failure instanceof EpEnvelopeError) || failure.code !== "unimplemented" || !failure.message.includes("unsupported")) throw new Error(`${command} did not refuse when its trusted provider was absent`, { cause: failure });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}