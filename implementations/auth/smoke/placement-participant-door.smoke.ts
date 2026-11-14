import assert from "node:assert/strict";
import { assertArgsValid, assertOutputValid, EpEnvelopeError, type EpServeContext } from "@cotal-ai/core";
import { AUTH_CONTRACTS, AUTH_PLACEMENT_COMMANDS, authClusterDocument, authCommandDefs, type AuthServiceHandlers } from "../src/auth-service-contract.js";
import type { PlacementEnrollmentAuthority } from "../src/placement-enrollment.js";
import { createPlacementDoorHandlers } from "../src/placement-participant-door.js";

// The door's own behaviour, driven through its handlers. The port's authentication, identity, and
// fence logic is proven by placement-enrollment.smoke.ts; this file proves the transport binding:
// the principal comes ONLY from the broker-authenticated subject, the boot window refuses honestly,
// and the published contract is closed against body claims.

const RECONCILER = { owner: "u_reconciler", actor: "reconciler", uid: "reconcileruid" };
const MANAGER = { owner: "u_manager", actor: "manager", uid: "manageruid" };
const RECONCILER_KEY = `${RECONCILER.owner}.${RECONCILER.actor}`;
const MANAGER_KEY = `${MANAGER.owner}.${MANAGER.actor}`;
const EFFECT = "11111111-1111-4111-8111-111111111111";
const FENCE = "22222222-2222-4222-8222-222222222222";
const OP = "33333333-3333-4333-8333-333333333333";
const IDENTITY = {
  acceptanceId: "44444444-4444-4444-8444-444444444444",
  enrollmentOperationId: "55555555-5555-4555-8555-555555555555",
  enrollmentRef: "ref-1",
  target: { seatName: "worker", lifecycle: { space: "main", owner: "u_manager", actor: "worker", lifecycleUid: "lifeuid0000000000000000000000" }, generation: 1 },
  intentDigest: `sha256:${"a".repeat(64)}`,
};
const CLAIM = { accountPublicKey: `A${"B".repeat(55)}`, instanceId: "instanceuid00000000000000000", managerLifecycleUid: "mgruid000000000000000000000", assignmentRevision: 1, currentRegistrationRevision: 11, serveEpoch: 7 };

// A fake ctx carrying only the broker-authenticated subject the door trusts, plus the validated args.
const ctx = (caller: { owner: string; actor: string; uid: string }, args: Record<string, unknown>): EpServeContext =>
  ({ subject: { caller }, request: { args } }) as unknown as EpServeContext;

// A recording port. It refuses any principal other than the reconciler key, the same way the real
// `authenticate` path does, so a forwarded manager principal surfaces as a typed refusal.
function recordingPort(): { port: PlacementEnrollmentAuthority; calls: { op: string; caller: string }[] } {
  const calls: { op: string; caller: string }[] = [];
  const admit = (op: string, caller: string) => {
    calls.push({ op, caller });
    if (caller !== RECONCILER_KEY) throw new EpEnvelopeError("permission-denied", "enrollment participant requires the reconciler service");
  };
  const port = {
    verifyPlacementEnrollment: async (a: { caller: string }) => { admit("verify", a.caller); return { identity: IDENTITY, active: true as const }; },
    enrollmentEffectStatus: async (a: { caller: string; effectId: string }) => { admit("status", a.caller); return { effectId: a.effectId, state: "effective" as const, enrollment: IDENTITY, noLateEffects: true, privateCustody: "none" as const }; },
    closeEnrollmentEffect: async (a: { caller: string; effectId: string }) => { admit("close", a.caller); return { effectId: a.effectId, state: "cancelled" as const, noLateEffects: true, privateCustody: "none" as const }; },
    retirePlacementEnrollment: async (a: { caller: string }) => { admit("retire", a.caller); return { state: "retired" as const, denialProofId: `sha256:${"c".repeat(64)}` }; },
  } as unknown as PlacementEnrollmentAuthority;
  return { port, calls };
}

// ---- A. manager with a reconciler body claim is refused -------------------------------------
// The body NAMES a reconciler; the door must still key the principal off the subject, so the port
// sees the manager and refuses it with its typed permission-denied.
{
  const { port, calls } = recordingPort();
  const h = createPlacementDoorHandlers({ configured: true, port: () => port });
  await assert.rejects(
    h.enrollmentEffectStatus(ctx(MANAGER, { effectId: EFFECT, caller: RECONCILER_KEY, principal: "reconciler" })),
    (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied",
  );
  assert.equal(calls.at(-1)?.caller, MANAGER_KEY, "the door must forward the SUBJECT principal, not the body-claimed one");
  console.log("  ✓ manager subject with a reconciler body claim is refused; the forwarded principal is the manager");
}

// ---- B. the door forwards the subject principal --------------------------------------------
{
  const { port, calls } = recordingPort();
  const h = createPlacementDoorHandlers({ configured: true, port: () => port });
  await h.verifyPlacementEnrollment(ctx(RECONCILER, { identity: IDENTITY, claim: CLAIM }));
  await h.enrollmentEffectStatus(ctx(RECONCILER, { effectId: EFFECT }));
  await h.closeEnrollmentEffect(ctx(RECONCILER, { effectId: EFFECT, fenceId: FENCE }));
  await h.retirePlacementEnrollment(ctx(RECONCILER, { operationId: OP, identity: IDENTITY, fenceId: FENCE }));
  assert.deepEqual(calls.map((c) => c.op), ["verify", "status", "close", "retire"]);
  assert.ok(calls.every((c) => c.caller === RECONCILER_KEY), "every op must forward the reconciler subject principal");
  console.log("  ✓ door forwards the subject principal on all four ops");
}

// ---- C. the three-way boot window -----------------------------------------------------------
{
  // C1. Not configured: permanent misconfiguration, so `unimplemented`.
  const unconfigured = createPlacementDoorHandlers({ configured: false, port: () => undefined });
  const cases: [string, () => Promise<unknown>][] = [
    ["verify", () => unconfigured.verifyPlacementEnrollment(ctx(RECONCILER, { identity: IDENTITY, claim: CLAIM }))],
    ["status", () => unconfigured.enrollmentEffectStatus(ctx(RECONCILER, { effectId: EFFECT }))],
    ["close", () => unconfigured.closeEnrollmentEffect(ctx(RECONCILER, { effectId: EFFECT, fenceId: FENCE }))],
    ["retire", () => unconfigured.retirePlacementEnrollment(ctx(RECONCILER, { operationId: OP, identity: IDENTITY, fenceId: FENCE }))],
  ];
  for (const [name, run] of cases) {
    await assert.rejects(run(), (e: unknown) => e instanceof EpEnvelopeError && e.code === "unimplemented", `${name} must refuse unimplemented when not configured`);
  }
  console.log("  ✓ not configured: every op refuses with unimplemented");

  // C2. Configured but the port is not built yet: transient, so `unavailable` with a retry message.
  const starting = createPlacementDoorHandlers({ configured: true, port: () => undefined });
  for (const [name, run] of [
    ["verify", () => starting.verifyPlacementEnrollment(ctx(RECONCILER, { identity: IDENTITY, claim: CLAIM }))],
    ["status", () => starting.enrollmentEffectStatus(ctx(RECONCILER, { effectId: EFFECT }))],
    ["close", () => starting.closeEnrollmentEffect(ctx(RECONCILER, { effectId: EFFECT, fenceId: FENCE }))],
    ["retire", () => starting.retirePlacementEnrollment(ctx(RECONCILER, { operationId: OP, identity: IDENTITY, fenceId: FENCE }))],
  ] as [string, () => Promise<unknown>][]) {
    await assert.rejects(run(), (e: unknown) => e instanceof EpEnvelopeError && e.code === "unavailable" && /starting/.test(e.message) && /retry/.test(e.message), `${name} must refuse unavailable (starting, retry) while configured but not ready`);
  }
  console.log("  ✓ configured but not ready: every op refuses with unavailable (starting, retry)");

  // C3. Configured and ready: the port answers, so no refusal.
  const { port } = recordingPort();
  const ready = createPlacementDoorHandlers({ configured: true, port: () => port });
  await ready.enrollmentEffectStatus(ctx(RECONCILER, { effectId: EFFECT }));
  console.log("  ✓ configured and ready: the port answers");
}

// ---- D. the four commands are the placement rows, closed against body claims ----------------
{
  assert.deepEqual([...AUTH_PLACEMENT_COMMANDS], ["verify-placement-enrollment", "enrollment-effect-status", "close-enrollment-effect", "retire-placement-enrollment"]);

  // Each row is untargeted on the placement capability: read the rows from the published document.
  const doc = authClusterDocument();
  for (const name of AUTH_PLACEMENT_COMMANDS) {
    const row = doc.commands.find((c) => c.name === name);
    assert.ok(row, `${name} must be a cluster-document row`);
    assert.equal(row.capability, "auth.placement", `${name} must carry capability auth.placement`);
    assert.equal(row.targeted, false, `${name} must be untargeted`);
  }
  console.log("  ✓ each placement row is capability auth.placement and untargeted");

  // The compiled input refuses an extra `caller` key: a body can never name the transport principal.
  const verifyArgs = { identity: IDENTITY, claim: CLAIM };
  assert.doesNotThrow(() => assertArgsValid(AUTH_CONTRACTS["verify-placement-enrollment"].input.validate, verifyArgs));
  assert.throws(
    () => assertArgsValid(AUTH_CONTRACTS["verify-placement-enrollment"].input.validate, { ...verifyArgs, caller: RECONCILER_KEY }),
    (e: unknown) => e instanceof EpEnvelopeError && e.code === "bad-request",
    "an extra caller key must be refused by the compiled input validator",
  );
  assert.throws(
    () => assertArgsValid(AUTH_CONTRACTS["enrollment-effect-status"].input.validate, { effectId: EFFECT, principal: "reconciler" }),
    (e: unknown) => e instanceof EpEnvelopeError && e.code === "bad-request",
    "an extra principal key must be refused by the compiled input validator",
  );
  // Representative port results: the compiled validators must accept the shapes the port returns.

  const { port } = recordingPort();
  const h = createPlacementDoorHandlers({ configured: true, port: () => port });
  const verifyOut = await h.verifyPlacementEnrollment(ctx(RECONCILER, { identity: IDENTITY, claim: CLAIM }));
  assertOutputValid(AUTH_CONTRACTS["verify-placement-enrollment"].output.validate, verifyOut);
  const statusOut = await h.enrollmentEffectStatus(ctx(RECONCILER, { effectId: EFFECT }));
  assertOutputValid(AUTH_CONTRACTS["enrollment-effect-status"].output.validate, statusOut);
  const closeOut = await h.closeEnrollmentEffect(ctx(RECONCILER, { effectId: EFFECT, fenceId: FENCE }));
  assertOutputValid(AUTH_CONTRACTS["close-enrollment-effect"].output.validate, closeOut);
  const retireOut = await h.retirePlacementEnrollment(ctx(RECONCILER, { operationId: OP, identity: IDENTITY, fenceId: FENCE }));
  assertOutputValid(AUTH_CONTRACTS["retire-placement-enrollment"].output.validate, retireOut);
  console.log("  ✓ port results pass the compiled output validators");

  // The four commands are served on the auth endpoint.
  const stub = (): unknown => { throw new EpEnvelopeError("unimplemented", "stub"); };
  const handlers: AuthServiceHandlers = { retireLifecycle: stub, verifyPlacementEnrollment: stub, enrollmentEffectStatus: stub, closeEnrollmentEffect: stub, retirePlacementEnrollment: stub };
  const defs = authCommandDefs(handlers);
  for (const name of AUTH_PLACEMENT_COMMANDS) assert.ok(defs.some((d) => d.command === name), `${name} must be served`);
  console.log("  ✓ the four placement commands are served on the auth endpoint");
}

console.log("placement participant door smoke passed");
