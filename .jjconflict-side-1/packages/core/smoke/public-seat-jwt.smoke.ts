/**
 * Broker-free smoke coverage for the stable own-DM reader and explicit minter endpoint grant rows.
 * The planned public seat signer is not integrated in this workspace yet; its public-key signing,
 * accepted-row, and DM-send assertions remain blocked on the signer and issuance seam.
 *
 * Run: pnpm exec tsx packages/core/smoke/public-seat-jwt.smoke.ts
 */
import assert from "node:assert/strict";
import {
  createSpaceAuth, credsClaims, dmDurable, dmStream, epRequestGrantRows, mintCreds, mintLifecycleUid, newIdentity,
  type EpCaller, type EpCapability,
} from "../src/index.js";

const space = "seatjwt";
const auth = await createSpaceAuth(space);
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor = "seat";
const uid = mintLifecycleUid();
const identity = newIdentity();
const durable = dmDurable(owner, actor, uid);
const expectedExpiry = Math.floor(Date.now() / 1000) + 120;
const dmCreds = await mintCreds(auth, identity, "dm-reader", {
  principal: { owner, actor }, lifecycleUid: uid, expiresAt: expectedExpiry,
});
const dm = credsClaims(dmCreds);
const dmPub = dm.nats?.pub?.allow ?? [];
const dmSub = dm.nats?.sub?.allow ?? [];
const DM = dmStream(space);
assert.equal(dm.sub, identity.id, "the DM credential is signed for its own user key");
assert.equal(dm.name, "dm-reader");
assert.equal(dm.iss, auth.account.signingPub, "the configured space account signing key issues the DM credential");
assert.equal(dm.exp, expectedExpiry, "the DM credential honors the requested expiry");
assert.deepEqual(dmPub, [
  `$JS.API.CONSUMER.INFO.${DM}.${durable}`,
  `$JS.API.CONSUMER.MSG.NEXT.${DM}.${durable}`,
  `$JS.ACK.${DM}.${durable}.>`,
], "the DM reader has only its own durable INFO, NEXT and ACK rows");
assert.deepEqual(dmSub, [`_INBOX_${identity.id}.>`], "the DM reader subscribes only to its own inbox");
assert.ok(!dmPub.some((row) => row.includes("$JS.API.CONSUMER.CREATE.")), "the DM reader cannot create its durable");
assert.ok(!dmPub.some((row) => /presence|anycast|liveness|control|delivery|endpoint|identity/i.test(row)), "the DM reader has no presence, anycast, liveness, control, delivery, endpoint or identity grants");
assert.ok(!dmSub.some((row) => /presence|anycast|liveness|control|delivery|endpoint|identity/i.test(row)), "the DM reader subscribes to no presence, anycast, liveness, control, delivery, endpoint or identity subjects");

const minterActor = "authority";
const minterUid = mintLifecycleUid();
const minter = newIdentity();
const minterCaller: EpCaller = { owner, actor: minterActor, uid: minterUid };
const mintCapability = { endpoint: "manager", command: "identity-mint" } satisfies EpCapability;
const outsideIdentityCapability = { endpoint: "manager", command: "identity-retire" } satisfies EpCapability;
const minterCreds = await mintCreds(auth, minter, "control-caller-privileged", {
  principal: { owner, actor: minterActor }, lifecycleUid: minterUid, endpointCapabilities: [mintCapability],
});
const minterClaims = credsClaims(minterCreds);
const minterPub = minterClaims.nats?.pub?.allow ?? [];
const expectedMintRow = epRequestGrantRows(space, mintCapability, minterCaller)[0];
const outsideIdentityRow = epRequestGrantRows(space, outsideIdentityCapability, minterCaller)[0];
assert.deepEqual(epRequestGrantRows(space, mintCapability, minterCaller), [expectedMintRow], "the requested identity-mint capability builds one exact publish row");
assert.deepEqual(epRequestGrantRows(space, outsideIdentityCapability, minterCaller), [outsideIdentityRow], "the outside identity-retire capability builds one exact publish row");
assert.ok(minterPub.includes(expectedMintRow), "the minter credential contains its requested identity-mint row");
assert.ok(!minterPub.includes(outsideIdentityRow), "the minter credential has no outside identity-retire request row");
assert.deepEqual(minterPub.filter((row) => row.includes(".identity-")), [expectedMintRow], "the minter receives only the exact requested identity command");
assert.ok(!dmPub.some((row) => row.includes(".identity-")), "the DM reader has no identity-command row");
assert.ok(!dmSub.some((row) => row.includes(".identity-")), "the DM reader subscribes to no identity-command subject");

console.log("public seat JWT smoke: stable DM-reader and minter endpoint rows passed");
