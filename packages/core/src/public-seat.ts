import { createHash } from "node:crypto";
import type { KV } from "@nats-io/kv";
import { assertValidName } from "./resolve.js";
import { nativeNkeySigner } from "./nkey-signer.js";
import { canonicalJson } from "./canonical.js";
import { isUserNkey } from "./identity.js";
import { epAuthBucket } from "./endpoint-binding.js";
import { credentialIdOf } from "./lifecycle-state.js";
import { acceptedKey, importNativeSubjectPermissions, issuedHorizon, writeAcceptedRow, type IssuedAuthorityRef, type IssuedSourceRef, type IssuedSubjectPermissions, type IssuanceSeam } from "./issued-authority.js";
import { signIssuedUserJwt } from "./issued-user-jwt.js";
import { MAX_MINTED_JWT_BYTES, permissionsFor, STANDING_RENEWABLE_TTL_SEC, type MintOpts, type MintPrincipal, type SpaceAccountAuth } from "./provision.js";

export type PublicSeatMintOptions = {
  name: string;
  principal: { owner: string; actor: string };
  lifecycleUid: string;
  issuedAt: number;
  expiresAt: number;
  issued: NonNullable<MintOpts["issued"]>;
  issuance: IssuanceSeam;
};

export interface PublicSeatMintAuth {
  space: string;
  account: Pick<SpaceAccountAuth["account"], "pub" | "signingSeed">;
}

interface PublicSeatMintContext {
  auth: PublicSeatMintAuth;
  publicId: string;
  opts: PublicSeatMintOptions;
  signer: ReturnType<typeof nativeNkeySigner>;
  perms: Record<string, unknown>;
  tags: string[];
  claimsDigest: string;
  ref: IssuedAuthorityRef;
  source: IssuedSourceRef;
  permissions: IssuedSubjectPermissions;
}

async function assertAcceptedRow(context: PublicSeatMintContext, accepted: KV): Promise<void> {
  const entry = await accepted.get(acceptedKey(context.opts.issued.acceptedToken));
  if (!entry || entry.operation !== "PUT" ||
      canonicalJson(entry.json<unknown>()) !== canonicalJson({ version: 1, ref: context.ref }))
    throw new Error("mintPublicSeatUserJwt: issuance has no identical accepted row");
}

function signPublicSeatJwt(context: PublicSeatMintContext, issuedAt: number, expiresAt: number): string {
  const jwt = signIssuedUserJwt({
    accountSigner: context.signer,
    accountIssuer: context.auth.account.pub,
    userPublicKey: context.publicId,
    name: context.opts.name,
    permissions: context.perms,
    tags: context.tags,
    exp: expiresAt,
    iat: issuedAt,
  });
  if (Buffer.byteLength(jwt, "utf8") > MAX_MINTED_JWT_BYTES)
    throw new Error("mintPublicSeatUserJwt: minted JWT exceeds the CONNECT line budget");
  return jwt;
}

async function issuePublicSeatJwt(context: PublicSeatMintContext): Promise<{ jwt: string; exp: number; acceptedToken: string }> {
  const { opts, ref, source, permissions } = context;
  const prepared = await opts.issuance.store.stage({
    version: 1,
    ref,
    sources: [source],
    permissions,
    issuedAt: opts.issuedAt,
    jwtExpiresAt: opts.expiresAt,
    jwtClaimsDigest: context.claimsDigest,
  });
  if (prepared.issuedAt !== opts.issuedAt || prepared.jwtExpiresAt !== opts.expiresAt || prepared.jwtClaimsDigest !== context.claimsDigest)
    throw new Error("mintPublicSeatUserJwt: prepared issuance is missing or mismatches persisted JWT claims");
  const jwt = signPublicSeatJwt(context, prepared.issuedAt, prepared.jwtExpiresAt);
  if (prepared.state === "prepared") {
    await opts.issuance.store.release(prepared, async () => { await opts.issuance.finalize?.(credentialIdOf(jwt)); });
  } else {
    if (prepared.state !== "active") throw new Error("mintPublicSeatUserJwt: issuance is not active");
    await opts.issuance.store.release(prepared, async () => {});
  }
  await writeAcceptedRow(opts.issuance.accepted, opts.issued.acceptedToken, ref);
  return { jwt, exp: prepared.jwtExpiresAt, acceptedToken: opts.issued.acceptedToken };
}

async function renewPublicSeatJwt(context: PublicSeatMintContext): Promise<{ jwt: string; exp: number; acceptedToken: string }> {
  const { opts, ref, source, permissions } = context;
  const previous = await opts.issuance.store.observe(ref);
  if (previous.evidence.sources.length !== 1 || canonicalJson(previous.evidence.sources[0]) !== canonicalJson(source))
    throw new Error("mintPublicSeatUserJwt: renewal source does not match the active issuance's static credential-family source");
  if (previous.evidence.jwtClaimsDigest !== context.claimsDigest ||
      previous.evidence.issuedAt === undefined || previous.evidence.jwtExpiresAt === undefined)
    throw new Error("mintPublicSeatUserJwt: renewal claims do not match immutable active issuance evidence");
  if (opts.issuedAt <= previous.evidence.issuedAt || opts.expiresAt <= previous.evidence.jwtExpiresAt)
    throw new Error("mintPublicSeatUserJwt: renewal must advance the persisted issuedAt and expiresAt");
  await opts.issuance.store.confirm(ref, permissions);
  const jwt = signPublicSeatJwt(context, opts.issuedAt, opts.expiresAt);
  await assertAcceptedRow(context, opts.issuance.accepted);
  await opts.issuance.finalize?.(credentialIdOf(jwt));
  return { jwt, exp: opts.expiresAt, acceptedToken: opts.issued.acceptedToken };
}

/** Issue or renew a DM-only seat credential without accepting the holder's private key. */
export async function mintPublicSeatUserJwt(
  auth: PublicSeatMintAuth,
  publicId: string,
  opts: PublicSeatMintOptions,
): Promise<{ jwt: string; exp: number; acceptedToken: string }> {
  if (!isUserNkey(publicId)) throw new Error("mintPublicSeatUserJwt: publicId must be a user nkey");
  assertValidName(opts.name);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(opts.issuedAt) || opts.issuedAt <= 0 || opts.issuedAt > now ||
      !Number.isSafeInteger(opts.expiresAt) || opts.expiresAt <= now || opts.expiresAt <= opts.issuedAt ||
      opts.expiresAt > opts.issuedAt + STANDING_RENEWABLE_TTL_SEC)
    throw new Error("mintPublicSeatUserJwt: persisted issuedAt and expiresAt must describe a live JWT no longer than 24 hours");

  const principal: MintPrincipal = { ...opts.principal, connId: publicId, lifecycleUid: opts.lifecycleUid };
  const mintOptions: MintOpts = { principal, lifecycleUid: opts.lifecycleUid, dmOnly: true, issued: opts.issued };
  const perms = permissionsFor("agent", auth.space, principal, mintOptions);
  const tags = [...principalTags(principal.owner, principal.actor), "profile:agent"];
  const encodedSeed = new TextEncoder().encode(auth.account.signingSeed);
  const signer = nativeNkeySigner(encodedSeed);
  encodedSeed.fill(0);
  try {
    const claimsDigest = createHash("sha256").update(canonicalJson({
      accountIssuer: auth.account.pub,
      signerPublicKey: signer.getPublicKey(),
      userPublicKey: publicId,
      name: opts.name,
      permissions: perms,
      tags,
    })).digest("hex");
    const ref: IssuedAuthorityRef = {
      space: auth.space,
      owner: principal.owner,
      actor: principal.actor,
      uid: opts.lifecycleUid,
      generation: opts.issued.generation,
    };
    const source = { space: auth.space, bucket: epAuthBucket(auth.space), key: `cred.${opts.lifecycleUid}` };
    if (opts.expiresAt > issuedHorizon(ref.generation))
      throw new Error(`mintPublicSeatUserJwt: expiresAt must not pass generation horizon ${issuedHorizon(ref.generation)}`);
    if (opts.issuance.sources.length !== 1 || canonicalJson(opts.issuance.sources[0]) !== canonicalJson(source))
      throw new Error("mintPublicSeatUserJwt: issuance must name this lifecycle's static credential-family source");
    const context: PublicSeatMintContext = {
      auth,
      publicId,
      opts,
      signer,
      perms,
      tags,
      claimsDigest,
      ref,
      source,
      permissions: importNativeSubjectPermissions(perms),
    };
    return opts.issuance.mode === "issue" ? await issuePublicSeatJwt(context) : await renewPublicSeatJwt(context);
  } finally {
    signer.clear();
  }
}
