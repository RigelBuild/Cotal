import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, mintLifecycleUid } from "@cotal-ai/core";
import { IdentityStore } from "../src/identity-store.js";

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
  const issued = { ...pending, state: "issued" as const };
  second.transition("alice", "signer", alice.lifecycleUid, pending.generation, issued, 5);
  assert.throws(
    () => first.transition("alice", "signer", alice.lifecycleUid, undefined, pending, 6),
    (error: unknown) => error instanceof EpEnvelopeError && error.code === "conflict",
    "stale issuance generations cannot overwrite a concurrent transition",
  );

  const retired = first.retire("alice", "signer", alice.lifecycleUid, issued.generation, 7);
  assert.equal(retired.retiredAt, 7, "retirement persists a terminal timestamp");
  assert.equal(retired.issuance?.state, "retired", "retirement terminalizes issued authority");
  assert.equal(second.ownsName("alice", "signer"), false, "retirement frees the name");
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
  assert.equal(reopened.ownsName("unissued", "other"), false, "retiring an unissued reservation frees its name");
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

  console.log("identity-store smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
