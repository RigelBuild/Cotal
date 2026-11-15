import { strict as assert } from "node:assert";
import type { SecretStore } from "@cotal-ai/core";
import {
  createPlacementTokenCustody,
  hashPlacementActorToken,
  PlacementTokenCustodyError,
  type PlacementTokenCipher,
} from "../src/placement-custody.js";

const values: Record<string, string> = {};
const secretStore: SecretStore = {
  get: async (key) => values[key],
  put: async (key, value) => { values[key] = value; },
  create: async (key, value) => {
    if (key in values) return false;
    values[key] = value;
    return true;
  },
  delete: async (key) => { delete values[key]; },
};

// Deliberately minimal in-memory cipher fake. Production supplies authenticated encryption.
const cipher: PlacementTokenCipher = {
  encrypt: async (token) => `sealed:${[...token].reverse().join("")}`,
  decrypt: async (ciphertext) => {
    if (!ciphertext.startsWith("sealed:")) throw new Error("invalid test ciphertext");
    return [...ciphertext.slice("sealed:".length)].reverse().join("");
  },
};
const custody = createPlacementTokenCustody(secretStore, cipher);
const operation = "enrollment-operation-1";
const actorToken = "actor-token-secret-value";
const actorTokenHash = hashPlacementActorToken(actorToken);
await custody.retain(operation, actorToken, actorTokenHash);
assert.equal(Object.keys(values).length, 1);
assert(!Object.values(values).some((record) => record.includes(actorToken)), "stored record must not serialize the raw token");
assert.equal(await custody.recover(operation, actorTokenHash), actorToken);

// Replaying identical custody is idempotent; altered token or hash cannot replace it.
await custody.retain(operation, actorToken, actorTokenHash);
assert.equal(Object.keys(values).length, 1);
await assert.rejects(
  custody.retain(operation, "different-actor-token", hashPlacementActorToken("different-actor-token")),
  (error: unknown) => error instanceof PlacementTokenCustodyError && error.code === "conflict",
);
await assert.rejects(
  custody.recover(operation, hashPlacementActorToken("different-actor-token")),
  (error: unknown) => error instanceof PlacementTokenCustodyError && error.code === "conflict",
);
assert.equal(await custody.recover(operation, actorTokenHash), actorToken);

// Concurrent identical first writes converge on one immutable operation record.
const concurrentOperation = "enrollment-operation-concurrent";
const concurrentToken = "concurrent-actor-token";
const concurrentHash = hashPlacementActorToken(concurrentToken);
await Promise.all([
  custody.retain(concurrentOperation, concurrentToken, concurrentHash),
  custody.retain(concurrentOperation, concurrentToken, concurrentHash),
]);
assert.equal(await custody.recover(concurrentOperation, concurrentHash), concurrentToken);

// A mismatched terminal signal cannot delete the retained record.
await assert.rejects(
  custody.terminalRefusal(concurrentOperation, hashPlacementActorToken("other-terminal-token")),
  (error: unknown) => error instanceof PlacementTokenCustodyError && error.code === "conflict",
);
assert.equal(await custody.recover(concurrentOperation, concurrentHash), concurrentToken);

await custody.terminalRefusal(operation, actorTokenHash);
assert.equal(await custody.recover(operation, actorTokenHash), undefined);

const retiredOperation = "enrollment-operation-retired";
const retiredToken = "retired-actor-token";
const retiredHash = hashPlacementActorToken(retiredToken);
await custody.retain(retiredOperation, retiredToken, retiredHash);
await custody.retire(retiredOperation, retiredHash);
assert.equal(await custody.recover(retiredOperation, retiredHash), undefined);

console.log("manager placement custody acceptance: passed");

