import { strict as assert } from "node:assert";
import { IdentityRetirementBackoff } from "../src/identity/retirements.js";

const backoff = new IdentityRetirementBackoff();
const uid = "identity-a";
assert.deepEqual(Array.from({ length: 10 }, () => backoff.nextDelay(uid)), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
assert.equal(backoff.nextDelay(uid), 300_000, "retry delay stays capped at five minutes");
assert.equal(backoff.nextDelay("identity-b"), 1_000, "identities have independent retry state");
backoff.reset(uid);
assert.equal(backoff.nextDelay(uid), 1_000, "successful retirement resets the retry sequence");
console.log("PASS identity retirement backoff doubles, caps at five minutes, and resets after success");
