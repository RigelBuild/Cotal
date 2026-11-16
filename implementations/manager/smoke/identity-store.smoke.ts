import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, mintLifecycleUid } from "@cotal-ai/core";
import { isAdoptedIdentity } from "../src/identity/adoption.js";
import { IdentityStore } from "../src/identity/store.js";

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const deadline = Date.now() + timeoutMs;
  const poll = (): void => {
    if (existsSync(path)) return resolve();
    if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`));
    setTimeout(poll, 10);
  };
  poll();
  return promise;
}

if (process.argv[2] === "reserve-worker") {
  const name = process.argv[3];
  const root = process.argv[4];
  const minter = process.argv[5];
  const barrier = process.argv[6];
  if (!name || !root || !minter || !barrier) throw new Error("reserve worker requires name, root, minter and barrier");
  const ready = join(barrier, `${name}.ready`);
  const go = join(barrier, "go");
  writeFileSync(ready, "ready\n");
  await waitForFile(go, 10_000);
  const record = new IdentityStore(root, "multiprocess", "manager").reserve(name, minter, Date.now(), 1);
  process.stdout.write(`${record.lifecycleUid}\n`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "cotal-identity-store-"));

try {
  const first = new IdentityStore(root, "smoke", "manager");
  const second = new IdentityStore(root, "smoke", "manager");
  const alice = first.reserve("alice", "signer", 1, 2);
  const bob = second.reserve("bob", "signer", 2, 2);

  assert.equal(first.get("bob")?.lifecycleUid, bob.lifecycleUid, "an independent store reloads another writer's record");
  assert.equal(first.list().length, 2, "records from separate store instances are both durable");

  const publicKey = `U${"A".repeat(55)}`;
  first.bindPublicKey("alice", "signer", alice.lifecycleUid, publicKey, 3);
  assert.equal(second.get("alice")?.publicKey, publicKey, "public-key binding is durable and repeat-safe");

  const pending = {
    generation: "a".repeat(32),
    iat: 10,
    exp: 20,
    acceptedToken: "b".repeat(32),
    issuanceId: mintLifecycleUid(),
    state: "pending" as const,
  };
  first.transition("alice", "signer", alice.lifecycleUid, undefined, pending, 4);
  const pendingRecord = first.get("alice");
  assert.ok(pendingRecord);
  const pendingSlot = { owner: "local", alias: "alice", actor: publicKey, lifecycleUid: alice.lifecycleUid, managerInstance: "manager", ownerInstanceId: "manager", phase: "provisioning" as const, credentialIds: [] };
  const identities = new Map([[alice.lifecycleUid, pendingRecord]]);
  assert.equal(isAdoptedIdentity(pendingSlot, identities), true, "pending provisioning slot remains adopted");
  assert.equal(isAdoptedIdentity({ ...pendingSlot, phase: "terminalizing" }, identities), false, "pending terminalizing slot is not adopted");
  console.log("PASS pending terminalizing identity slot is not adopted");
  const issued = { ...pending, state: "issued" as const };
  second.transition("alice", "signer", alice.lifecycleUid, pending.generation, issued, 5);
  assert.throws(
    () => first.transition("alice", "signer", alice.lifecycleUid, undefined, pending, 6),
    (error: unknown) => error instanceof EpEnvelopeError && error.code === "conflict",
    "stale issuance generations cannot overwrite a concurrent transition",
  );
  const expiredIntent = { issuanceId: mintLifecycleUid(), iat: 11, exp: 21 };
  first.beginRenewal("alice", "signer", alice.lifecycleUid, issued.issuanceId, expiredIntent);
  const replacementIntent = { issuanceId: mintLifecycleUid(), iat: 22, exp: 40 };
  const replacedIntent = second.beginRenewal("alice", "signer", alice.lifecycleUid, issued.issuanceId, replacementIntent);
  assert.deepEqual(replacedIntent.renewal, replacementIntent);
  console.log("PASS expired pending renewal is atomically replaced");

  const retired = first.retire("alice", "signer", alice.lifecycleUid, issued.generation, 7);
  assert.equal(retired.retiredAt, 7, "retirement persists a terminal timestamp");
  assert.equal(retired.issuance?.state, "retired", "retirement terminalizes issued authority");
  assert.throws(
    () => second.transition("alice", "signer", alice.lifecycleUid, issued.generation, { ...issued, exp: 21 }, 8),
    (error: unknown) => error instanceof EpEnvelopeError && error.code === "failed-precondition",
    "retired identity cannot be revived by an issuance transition",
  );

  const replacement = second.reserve("alice", "signer", 8, 2);
  assert.notEqual(replacement.lifecycleUid, alice.lifecycleUid, "re-reserving a retired name mints a fresh UID");
  const reopened = new IdentityStore(root, "smoke", "manager");
  assert.equal(reopened.get("alice")?.lifecycleUid, replacement.lifecycleUid, "name lookup returns the current UID");
  assert.equal(reopened.getByUid(alice.lifecycleUid)?.retiredAt, 7, "the old UID tombstone survives restart");
  assert.equal(reopened.list().length, 3, "retired UID history is retained beside the replacement");

  const unissued = reopened.reserve("unissued", "other", 9, 1);
  const retiredReservation = reopened.retire("unissued", "other", unissued.lifecycleUid, undefined, 10);
  assert.equal(retiredReservation.retiredAt, 10, "an unissued reservation can be retired");
  reopened.retire("alice", "signer", replacement.lifecycleUid, undefined, 10);

  const nextMinter = reopened.reserve("alice", "next-minter", 11, 1);
  assert.notEqual(nextMinter.lifecycleUid, alice.lifecycleUid, "a different minter gets a fresh lifecycle UID");
  assert.equal(nextMinter.minter, "next-minter", "a different minter can claim a retired name");
  assert.equal(reopened.getByUid(alice.lifecycleUid)?.minter, "signer", "the previous minter's UID metadata is unchanged");

  assert.throws(
    () => reopened.reserve("over-cap", "next-minter", 12, 1),
    (error: unknown) => error instanceof EpEnvelopeError && error.code === "resource-exhausted" &&
      error.details?.some((detail) => detail.kind === "ai.cotal.ep.seat-mint-cap" && detail.seats === 1 && detail.cap === 1) === true,
    "cap checking and reservation share the same transaction",
  );
  const multiprocessRoot = mkdtempSync(join(tmpdir(), "cotal-identity-store-race-"));
  const barrier = mkdtempSync(join(tmpdir(), "cotal-identity-store-barrier-"));
  const worker = new URL(import.meta.url).pathname;
  const minter = "shared-minter";
  const runChild = (name: string): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, "reserve-worker", name, multiprocessRoot, minter, barrier], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.once("error", (error) => reject(error));
    child.once("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
  try {
    const left = runChild("left");
    const right = runChild("right");
    await Promise.all([waitForFile(join(barrier, "left.ready"), 10_000), waitForFile(join(barrier, "right.ready"), 10_000)]);
    writeFileSync(join(barrier, "go"), "go\n");
    const results = await Promise.all([left, right]);
    assert.deepEqual(results.map((result) => result.status).sort(), [0, 1], "separate processes must serialize cap checking and reservation");
    assert.equal(results.filter((result) => result.status === 0 && result.stdout.trim().length > 0).length, 1, "one child must reserve the single allowed identity");
    assert.equal(new IdentityStore(multiprocessRoot, "multiprocess", "manager").list().length, 1);
    console.log("PASS concurrent child-process reserves enforce one shared seat-mint cap");
  } finally {
    rmSync(barrier, { recursive: true, force: true });
    rmSync(multiprocessRoot, { recursive: true, force: true });
  }
  reopened.latchRetirement("alice", "next-minter", nextMinter.lifecycleUid);
  assert.equal(new IdentityStore(root, "smoke", "manager").get("alice")?.terminalizing, true);
  assert.throws(() => reopened.reserve("alice", "next-minter", 13, 1),
    (error: unknown) => error instanceof EpEnvelopeError && error.code === "failed-precondition");
  console.log("PASS reserve refused while terminalizing");

  console.log("identity-store smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
