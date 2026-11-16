import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PlacementEnrollmentStore, type PlacementEnrollmentRequest } from "../src/placement-enrollment-store.js";

const root = mkdtempSync(join(process.cwd(), `.placement-enrollment-${randomUUID()}-`));
const store = new PlacementEnrollmentStore(root);
const acceptanceId = "a5dd60b6-195a-43e4-9612-b84e1a953b65";
const enrollmentOperationId = "b4bc923c-8f50-44fa-86b7-c50d78d39e1d";
const authority = {
  subject: { acceptanceId, enrollmentOperationId, phase: "accepted" as const },
  placementOperationId: "c7bbf8c1-936b-4c0d-a8c2-60bab37e9130",
  intentDigest: `sha256:${"d".repeat(64)}`,
  claim: { accountPublicKey: `N${"A".repeat(55)}`, instanceId: `manager_${"a".repeat(26)}`, managerLifecycleUid: `life_${"b".repeat(26)}`, assignmentRevision: 1, currentRegistrationRevision: 2, serveEpoch: 3 },
  launchRevision: 1,
};
const request: PlacementEnrollmentRequest = { acceptanceId, enrollmentOperationId, authority, actorTokenHash: "a".repeat(64) };
const result = {
  identity: {
    acceptanceId,
    enrollmentOperationId,
    enrollmentRef: "enroll_ref",
    target: { seatName: "seat", lifecycle: { space: "main", owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "seat", lifecycleUid: "life_aaaaaaaaaaaaaaaaaaaaaaaaaa" }, generation: 1 },
    intentDigest: `sha256:${"b".repeat(64)}`,
  },
  material: {
    owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    actor: "seat",
    lifecycleUid: "life_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    sentinelCreds: "opaque",
    subscribe: [],
    allowSubscribe: [],
    allowPublish: [],
    agentBearerExchangeUrl: "https://example.invalid/exchange",
  },
};

let startedResolve: (() => void) | undefined;
const started = new Promise<void>((resolve) => { startedResolve = resolve; });
let releaseResolve: (() => void) | undefined;
const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
let enrollCalls = 0;
try {
  const first = store.execute(request, async () => {
    enrollCalls++;
    startedResolve?.();
    await release;
    return result;
  });
  await started;
  const replay = store.execute(request, async () => {
    enrollCalls++;
    return result;
  });
  releaseResolve?.();
  const [firstResult, replayResult] = await Promise.all([first, replay]);
  assert.deepEqual(firstResult, result, "the first response follows its durable completion");
  assert.deepEqual(replayResult, result, "concurrent exact replay returns the retained result");
  assert.equal(enrollCalls, 1, "concurrent retries admit enrollment once");
  assert.deepEqual(await store.lookup(request.enrollmentOperationId), result, "lookup returns the exact retained result");
  console.log("  ✓ concurrent identical replay returns one fsynced result");

  await assert.rejects(store.execute({ ...request, actorTokenHash: "c".repeat(64) }, async () => {
    enrollCalls++;
    return result;
  }), /replayed with changed authority/);
  assert.equal(enrollCalls, 1, "changed replay never starts another enrollment");
  console.log("  ✓ changed replay refuses without another enrollment");

  const reloaded = new PlacementEnrollmentStore(root);
  assert.deepEqual(await reloaded.lookup(request.enrollmentOperationId), result, "reopen replays persisted output exactly");
  appendFileSync(store.path, '{"torn":');
  const recovered = new PlacementEnrollmentStore(root);
  assert.deepEqual(await recovered.lookup(request.enrollmentOperationId), result, "torn final bytes do not lose the complete operation");
  assert.equal(readFileSync(store.path, "utf8").endsWith("\n"), true, "recovery restores a newline-terminated journal");
  assert.equal(readFileSync(store.path, "utf8").includes('{"torn":'), false, "recovery truncates the torn tail");
  console.log("  ✓ torn tail recovery preserves complete enrollment records");

  const pendingId = "e82a555f-e62c-49ea-8a42-b46a57d56814";
  const pendingRequest = { ...request, enrollmentOperationId: pendingId, authority: { ...authority, subject: { ...authority.subject, enrollmentOperationId: pendingId } } };
  await assert.rejects(store.execute(pendingRequest, async () => {
    enrollCalls++;
    throw new Error("simulated lost enrollment response");
  }), /simulated lost enrollment response/);
  await assert.rejects(store.execute(pendingRequest, async () => {
    enrollCalls++;
    return result;
  }), /unresolved durable reservation/);
  assert.equal(enrollCalls, 2, "an unresolved reservation cannot create a second enrollment");
  console.log("  ✓ unresolved durable reservation fails closed against replay");

} finally {
  rmSync(root, { recursive: true, force: true });
}
