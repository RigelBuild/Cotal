import assert from "node:assert/strict";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { credsClaims, jwtFromCreds, newIdentity, verifyStaticUserCredential } from "../src/identity.js";
import { createSpaceAuth, mintCreds, mintPublicUserJwt } from "../src/provision.js";
import { nativeNkeySigner } from "../src/nkey-signer.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const auth = await createSpaceAuth("profile-smoke");
const pins = { accountPub: auth.account.pub, signingPub: auth.account.signingPub };
const holder = newIdentity();
const seed = fromSeed(encoder.encode(holder.seed));
const wrap = (jwt: string) => decoder.decode(fmtCreds(jwt, seed));
const verify = (creds: string, options: { allowOutOfWindow?: boolean; requireProfile?: boolean } = {}) =>
  verifyStaticUserCredential(creds, pins, options);
const creds = await mintCreds(auth, holder, "probe", { name: "custom-holder" });
assert.equal(credsClaims(creds).name, "custom-holder");
assert.equal(verify(creds, { requireProfile: true }).profile, "probe");
assert.equal(verify(creds).identity, holder.id);
const publicMint = await mintPublicUserJwt(auth, holder.id, "session-ledger", {});
assert.equal(verify(wrap(publicMint.jwt), { requireProfile: true }).profile, "session-ledger");
const fixture = async (tags?: string[]) => wrap(await encodeUser(
  "fixture", fromPublic(holder.id), fromPublic(auth.account.pub),
  tags === undefined ? {} : { tags },
  { signer: nativeNkeySigner(encoder.encode(auth.account.signingSeed)) },
));
for (const tags of [undefined, ["profile:unknown"], ["profile:probe", "profile:probe"], ["profile:probe", "profile:admin"]]) {
  const credential = await fixture(tags);
  assert.equal(verify(credential).profile, null);
  assert.throws(() => verify(credential, { requireProfile: true }));
}
const jwt = jwtFromCreds(creds);
assert.ok(jwt);
const otherHolder = newIdentity();
assert.throws(() => verify(decoder.decode(fmtCreds(jwt, fromSeed(encoder.encode(otherHolder.seed)))), { requireProfile: true }));
const parts = jwt.split(".");
assert.equal(parts.length, 3);
const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
payload.nats.tags = ["profile:admin"];
const altered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
assert.throws(() => verify(wrap(altered), { requireProfile: true }));
const signature = parts[2]!;
const badSignature = `${parts[0]}.${parts[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
assert.throws(() => verify(wrap(badSignature), { requireProfile: true }));
const expired = await mintCreds(auth, holder, "probe", { expiresAt: Math.floor(Date.now() / 1000) - 1 });
assert.throws(() => verify(expired));
assert.equal(verify(expired, { allowOutOfWindow: true, requireProfile: true }).profile, "probe");
const other = await createSpaceAuth("other-profile-smoke");
assert.throws(() => verifyStaticUserCredential(expired, { accountPub: pins.accountPub, signingPub: other.account.signingPub }, { allowOutOfWindow: true }));
assert.throws(() => verifyStaticUserCredential(expired, { accountPub: other.account.pub, signingPub: pins.signingPub }, { allowOutOfWindow: true }));
console.log("credential profile smoke passed");
