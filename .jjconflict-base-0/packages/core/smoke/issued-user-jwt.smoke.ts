import assert from "node:assert/strict";
import { createAccount, createUser } from "@nats-io/nkeys";
import { decodeNatsJwt, nativeNkeySigner, signIssuedUserJwt, type IssuedUserJwtInput } from "../src/index.js";

interface UserClaims {
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly jti: string;
  readonly name: string;
  readonly nats: {
    readonly data: number;
    readonly payload: number;
    readonly subs: number;
    readonly pub: { readonly allow: readonly string[] };
    readonly sub: { readonly allow: readonly string[] };
    readonly tags: readonly string[];
    readonly issuer_account: string;
    readonly type: string;
    readonly version: number;
  };
  readonly sub: string;
}

const account = createAccount();
const signerSeed = createAccount();
const user = createUser();
const signerSeedBytes = signerSeed.getSeed();
const accountSigner = nativeNkeySigner(signerSeedBytes);
signerSeedBytes.fill(0);
signerSeed.clear();

try {
  const permissions = {
    pub: { allow: ["chat.local.agent.general"] },
    sub: { allow: ["_INBOX.agent.>"] },
  };
  const input: IssuedUserJwtInput = {
    accountSigner,
    accountIssuer: account.getPublicKey(),
    userPublicKey: user.getPublicKey(),
    name: "issued-user-smoke",
    permissions,
    tags: ["owner:local", "actor:agent"],
    exp: 2_000_000_000,
    iat: 1_700_000_000,
  };

  const first = signIssuedUserJwt(input);
  const second = signIssuedUserJwt(input);
  assert.equal(second, first, "replaying the same persisted claims must reproduce the exact JWT and signature");

  const claims = decodeNatsJwt<UserClaims>(first);
  assert.equal(claims.aud, "NATS");
  assert.equal(claims.exp, input.exp);
  assert.equal(claims.iat, input.iat);
  assert.equal(claims.iss, accountSigner.getPublicKey());
  assert.equal(claims.name, input.name);
  assert.equal(claims.sub, input.userPublicKey);
  assert.equal(claims.nats.issuer_account, input.accountIssuer);
  assert.equal(claims.nats.type, "user");
  assert.equal(claims.nats.version, 2);
  assert.equal(claims.nats.data, -1);
  assert.equal(claims.nats.payload, -1);
  assert.equal(claims.nats.subs, -1);
  assert.deepEqual(claims.nats.pub, permissions.pub);
  assert.deepEqual(claims.nats.sub, permissions.sub);
  assert.deepEqual(claims.nats.tags, input.tags);
  assert.deepEqual(Object.keys(claims), ["exp", "aud", "name", "sub", "nats", "iss", "iat", "jti"]);
  assert.equal(Object.hasOwn(claims, "nbf"), false, "undefined native nbf option is omitted from JWT JSON");

  const changedIat = signIssuedUserJwt({ ...input, iat: input.iat + 1 });
  assert.notEqual(changedIat, first, "iat changes must change the deterministic claim digest and signed JWT");
  assert.equal(decodeNatsJwt<UserClaims>(changedIat).iat, input.iat + 1);

  assert.throws(() => signIssuedUserJwt({ ...input, iat: Number.NaN }), /iat/);
  assert.throws(() => signIssuedUserJwt({ ...input, iat: 1.5 }), /iat/);
  assert.throws(() => signIssuedUserJwt({ ...input, exp: Number.NaN }), /exp/);
  assert.throws(() => signIssuedUserJwt({ ...input, exp: 1.5 }), /exp/);
} finally {
  accountSigner.clear();
  account.clear();
  user.clear();
}

console.log("issued user JWT signer smoke passed");
