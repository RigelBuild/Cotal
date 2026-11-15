import { createHash } from "node:crypto";
import { fromPublic, type KeyPair } from "@nats-io/nkeys";

export interface IssuedUserJwtInput {
  readonly accountSigner: KeyPair;
  readonly accountIssuer: string;
  readonly userPublicKey: string;
  readonly name: string;
  readonly permissions: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly exp: number;
  readonly iat: number;
}

/** Create an NATS v2 user JWT with the persisted iat and @nats-io/jwt's deterministic claim format. */
export function signIssuedUserJwt(input: IssuedUserJwtInput): string {
  if (!Number.isSafeInteger(input.iat) || input.iat < 0) {
    throw new Error("signIssuedUserJwt: iat must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.exp) || input.exp < 0) {
    throw new Error("signIssuedUserJwt: exp must be a non-negative safe integer");
  }

  const issuerPair = fromPublic(input.accountIssuer);
  const signerPub = input.accountSigner.getPublicKey();
  const signerPair = fromPublic(signerPub);
  const validAccountKeys = input.accountIssuer.startsWith("A") && issuerPair.getPublicKey() === input.accountIssuer &&
    signerPub.startsWith("A") && signerPair.getPublicKey() === signerPub;
  issuerPair.clear();
  signerPair.clear();
  if (!validAccountKeys) throw new Error("signIssuedUserJwt: account issuer and signer must be account public nkeys");

  const userPair = fromPublic(input.userPublicKey);
  const userPub = userPair.getPublicKey();
  userPair.clear();
  if (!userPub.startsWith("U")) throw new Error("signIssuedUserJwt: user public key must be a user nkey");

  const permissionInput: unknown = input.permissions;
  if (typeof permissionInput !== "object" || permissionInput === null || Array.isArray(permissionInput)) {
    throw new Error("signIssuedUserJwt: permissions must be a user permissions object");
  }
  const tags = [...input.tags];
  if (!tags.every((tag) => typeof tag === "string")) throw new Error("signIssuedUserJwt: tags must be strings");

  const nats: Record<string, unknown> = {
    data: -1,
    payload: -1,
    subs: -1,
    ...permissionInput,
    tags,
    issuer_account: input.accountIssuer,
    type: "user",
  };
  nats.version = 2;
  const claim: Record<string, unknown> = {
    exp: input.exp,
    nbf: undefined,
    aud: "NATS",
    name: input.name,
    sub: userPub,
    nats,
    iss: signerPub,
    iat: input.iat,
  };
  claim.jti = createHash("sha512").update(JSON.stringify(claim)).digest("base64");

  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signed = `${header}.${payload}`;
  const signature = Buffer.from(input.accountSigner.sign(new TextEncoder().encode(signed))).toString("base64url");
  return `${signed}.${signature}`;
}
