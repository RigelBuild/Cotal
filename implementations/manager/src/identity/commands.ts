import {
  DEV_OWNER,
  EpEnvelopeError,
  mintAcceptedToken,
  mintGeneration,
  mintLifecycleUid,
  mintPublicSeatUserJwt,
  principalKey,
  STATIC_GENERATION_HORIZON_SEC,
  runActivationSagaAtUid,
  STANDING_RENEWABLE_TTL_SEC as MANAGED_STATIC_TTL_SEC,
  issuedHorizon,
  credentialIdOf,
  type EpServeContext,
  type IssuanceSeam,
  type IssuedStore,
  type LifecycleStateTransport,
  type SpaceAuth,
} from "@cotal-ai/core";
import type { CotalEndpoint } from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import {
  casStaticSlot,
  activateStaticLifecycle,
  readStaticSlot,
} from "../static-lifecycle.js";
import { IdentityStore, type IdentityRecord } from "./store.js";
import { waitForIdentityFlights } from "./retirements.js";
export type IdentityMintResult = { name: string; jwt: string; lifecycleUid: string; exp: number; acceptedToken: string };
export interface IdentityIssuerContext { store: IssuedStore; accepted: KV }

type LifecyclePin = { owner: string; actor: string; lifecycleUid: string; alias: string };
export interface IdentityCommandServices {
  readonly managerName: string;
  readonly seatMintCap: number;
  readonly auth?: SpaceAuth;
  readonly managerLifecycleUid: string;
  readonly managerInstanceId: string;
  readonly identityMintFlights: Map<string, Promise<IdentityMintResult>>;
  readonly identityRenewFlights: Map<string, Promise<IdentityMintResult>>;
  identityStoreForCommand(): IdentityStore;
  withLifecycleExecutor<T>(pin: LifecyclePin, fn: (transport: LifecycleStateTransport) => Promise<T>): Promise<T>;
  withProvisioner<T>(fn: (provisioner: CotalEndpoint) => Promise<T>): Promise<T>;
  withIssuer<T>(fn: (issuer: IdentityIssuerContext) => Promise<T>): Promise<T>;
  issuanceSeam(issuer: IdentityIssuerContext, mode: "issue" | "renew", identity: { name: string; id: string; lifecycleUid: string }, exp: number): IssuanceSeam;
  recheckIdentityRetirements(): Promise<void>;
}
/** Resume activation of the exact persisted identity slot after interruption. */
export async function resumeIdentityActivation(t: LifecycleStateTransport, args: { owner: string; alias: string; actor: string; lifecycleUid: string; managerInstance: string; ownerInstanceId: string }): Promise<void> {
  const slot = await readStaticSlot(t, args.owner, args.alias);
  if (!slot || slot.row.phase === "retired" && slot.row.lifecycleUid !== args.lifecycleUid) {
    await activateStaticLifecycle(t, args);
    return;
  }
  if (slot.row.lifecycleUid !== args.lifecycleUid || slot.row.actor !== args.actor || (slot.row.phase !== "provisioning" && slot.row.phase !== "active"))
    throw new EpEnvelopeError("failed-precondition", "identity static slot does not match its issuance", undefined, "not-executed");
  await runActivationSagaAtUid(t, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, managerInstance: slot.row.managerInstance });
}

/** Parse a compact identity command name before deriving its durable alias. */
export function identityAlias(managerName: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw))
    throw new EpEnvelopeError("bad-request", "identity name must be a lowercase slug of at most 64 characters", undefined, "not-executed");
  const alias = `${managerName}-${raw}`;
  if (alias.length > 64)
    throw new EpEnvelopeError("bad-request", "the manager name plus identity slug must be at most 64 characters", undefined, "not-executed");
  return alias;
}

export function identityReserve(services: IdentityCommandServices, ctx: EpServeContext): { name: string; lifecycleUid: string } {
  const store = services.identityStoreForCommand();
  const input = ctx.request.args;
  const slug = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).name : undefined;
  const name = identityAlias(services.managerName, slug);
  const record = store.reserve(name, principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key, Date.now(), services.seatMintCap);
  return { name, lifecycleUid: record.lifecycleUid };
}

async function retireIdentity(services: IdentityCommandServices, ctx: EpServeContext, minter?: string): Promise<Record<string, never>> {
  const store = services.identityStoreForCommand();
  const input = ctx.request.args;
  const slug = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).name : undefined;
  const name = identityAlias(services.managerName, slug);
  const record = store.get(name);
  if (!record) throw new EpEnvelopeError("not-found", `identity ${name} has no reservation`, undefined, "not-executed");
  if (minter !== undefined && record.minter !== minter)
    throw new EpEnvelopeError("permission-denied", `identity ${name} is owned by another minter`, undefined, "not-executed");
  const caller = record.minter;
  if (record.retiredAt !== undefined || record.issuance?.state === "retired") return {};
  store.latchRetirement(name, caller, record.lifecycleUid);
  await waitForIdentityFlights(services, record.lifecycleUid);
  store.recordRetirementExpiry(name, caller, record.lifecycleUid);
  void services.recheckIdentityRetirements().catch((error) => console.error(`identity retirement sweep: ${error instanceof Error ? error.message : String(error)}`));
  return {};
}

export function identityRetire(services: IdentityCommandServices, ctx: EpServeContext): Promise<Record<string, never>> {
  return retireIdentity(services, ctx, principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key);
}

export function identityRetireAdmin(services: IdentityCommandServices, ctx: EpServeContext): Promise<Record<string, never>> {
  return retireIdentity(services, ctx);
}

async function mintIdentityFlight(
  services: IdentityCommandServices,
  store: IdentityStore,
  record: IdentityRecord,
  name: string,
  minter: string,
  publicKey: string,
): Promise<IdentityMintResult> {
  const now = Math.floor(Date.now() / 1000);
  let issuance = record.initialIssuance ?? record.issuance;
  if (!issuance) {
    issuance = {
      generation: mintGeneration(now + STATIC_GENERATION_HORIZON_SEC),
      acceptedToken: mintAcceptedToken(),
      issuanceId: mintLifecycleUid(),
      iat: now,
      exp: now + MANAGED_STATIC_TTL_SEC,
      state: "pending",
    };
    store.transition(name, minter, record.lifecycleUid, undefined, issuance);
  }
  if (issuance.state !== "pending" && issuance.state !== "issued")
    throw new EpEnvelopeError("failed-precondition", "identity issuance is terminalizing", undefined, "not-executed");
  if (issuance.state === "pending" && issuance.exp <= now)
    throw new EpEnvelopeError("failed-precondition", "pending identity issuance has expired; retire the identity before reserving again", undefined, "not-executed");
  if (issuance.state === "pending") {
    await services.withLifecycleExecutor({ owner: DEV_OWNER, actor: publicKey, lifecycleUid: record.lifecycleUid, alias: name }, (transport) =>
      resumeIdentityActivation(transport, { owner: DEV_OWNER, alias: name, actor: publicKey, lifecycleUid: record.lifecycleUid, managerInstance: services.managerLifecycleUid, ownerInstanceId: services.managerInstanceId }));
  }
  const current = store.get(name);
  if (!current || current.terminalizing || current.retiredAt !== undefined)
    throw new EpEnvelopeError("failed-precondition", "identity is terminalizing", undefined, "not-executed");
  await services.withProvisioner((provisioner) => provisioner.provisionDmInbox(DEV_OWNER, publicKey, record.lifecycleUid));
  const minted = await services.withIssuer((issuer) => mintPublicSeatUserJwt(services.auth!, publicKey, {
    name,
    principal: { owner: DEV_OWNER, actor: publicKey },
    lifecycleUid: record.lifecycleUid,
    issuedAt: issuance.iat,
    expiresAt: issuance.exp,
    issued: { generation: issuance.generation, acceptedToken: issuance.acceptedToken },
    issuance: services.issuanceSeam(issuer, "issue", { name, id: publicKey, lifecycleUid: record.lifecycleUid }, issuance.exp),
  }));
  if (issuance.state === "pending") await activateMintedIdentity(services, store, record, name, minter, publicKey, issuance, minted.jwt);
  if (issuance.credentialId !== undefined && issuance.credentialId !== credentialIdOf(minted.jwt))
    throw new EpEnvelopeError("failed-precondition", "identity credential does not match its persisted reference", undefined, "not-executed");
  return { name, lifecycleUid: record.lifecycleUid, ...minted };
}

async function activateMintedIdentity(
  services: IdentityCommandServices,
  store: IdentityStore,
  record: IdentityRecord,
  name: string,
  minter: string,
  publicKey: string,
  issuance: NonNullable<IdentityRecord["issuance"]>,
  jwt: string,
): Promise<void> {
  const credentialId = credentialIdOf(jwt);
  await services.withLifecycleExecutor({ owner: DEV_OWNER, actor: publicKey, lifecycleUid: record.lifecycleUid, alias: name }, async (transport) => {
    const slot = await readStaticSlot(transport, DEV_OWNER, name);
    if (!slot || slot.row.lifecycleUid !== record.lifecycleUid || slot.row.actor !== publicKey || (slot.row.phase !== "provisioning" && slot.row.phase !== "active") || !slot.row.credentialIds.includes(credentialId))
      throw new EpEnvelopeError("failed-precondition", "identity static slot does not match its issuance", undefined, "not-executed");
    if (slot.row.phase === "provisioning") await casStaticSlot(transport, { ...slot.row, phase: "active" }, slot.revision);
  });
  store.transition(name, minter, record.lifecycleUid, issuance.generation, { ...issuance, credentialId, state: "issued" });
}

export async function identityMint(services: IdentityCommandServices, ctx: EpServeContext): Promise<IdentityMintResult> {
  const store = services.identityStoreForCommand();
  const input = ctx.request.args;
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("name" in input) || !("lifecycleUid" in input) || !("publicKey" in input) || typeof input.lifecycleUid !== "string" || typeof input.publicKey !== "string")
    throw new EpEnvelopeError("bad-request", "identity mint requires a name, lifecycle UID and public key", undefined, "not-executed");
  const name = identityAlias(services.managerName, input.name);
  const minter = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
  const record = store.get(name);
  if (!record) throw new EpEnvelopeError("not-found", `identity ${name} has no reservation`, undefined, "not-executed");
  if (record.minter !== minter) throw new EpEnvelopeError("permission-denied", `identity ${name} is owned by another minter`, undefined, "not-executed");
  if (record.lifecycleUid !== input.lifecycleUid) throw new EpEnvelopeError("failed-precondition", "identity lifecycle UID does not match its reservation", undefined, "not-executed");
  const bound = store.bindPublicKey(name, minter, record.lifecycleUid, input.publicKey);
  const existing = services.identityMintFlights.get(record.lifecycleUid);
  if (existing) return existing;
  const flight = mintIdentityFlight(services, store, bound, name, minter, input.publicKey);
  services.identityMintFlights.set(record.lifecycleUid, flight);
  try { return await flight; } finally { if (services.identityMintFlights.get(record.lifecycleUid) === flight) services.identityMintFlights.delete(record.lifecycleUid); }
}

async function renewIdentityFlight(
  services: IdentityCommandServices,
  store: IdentityStore,
  record: IdentityRecord,
  name: string,
  minter: string,
  publicKey: string,
): Promise<IdentityMintResult> {
  const issuance = record.issuance!;
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + MANAGED_STATIC_TTL_SEC, issuedHorizon(issuance.generation));
  const saved = store.beginRenewal(name, minter, record.lifecycleUid, issuance.issuanceId, { issuanceId: mintLifecycleUid(), iat: now, exp });
  const pending = saved.renewal;
  if (!pending) throw new Error("renewal intent was not persisted");
  const minted = await services.withIssuer((issuer) => mintPublicSeatUserJwt(services.auth!, publicKey, {
    name,
    principal: { owner: DEV_OWNER, actor: publicKey },
    lifecycleUid: record.lifecycleUid,
    issuedAt: pending.iat,
    expiresAt: pending.exp,
    issued: { generation: issuance.generation, acceptedToken: issuance.acceptedToken },
    issuance: services.issuanceSeam(issuer, "renew", { name, id: publicKey, lifecycleUid: record.lifecycleUid }, pending.exp),
  }));
  store.finishRenewal(name, minter, record.lifecycleUid, pending.issuanceId, credentialIdOf(minted.jwt));
  return { name, lifecycleUid: record.lifecycleUid, ...minted };
}

export async function identityRenew(services: IdentityCommandServices, ctx: EpServeContext): Promise<IdentityMintResult> {
  const store = services.identityStoreForCommand();
  const input = ctx.request.args;
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("name" in input) || !("publicKey" in input) || typeof input.publicKey !== "string")
    throw new EpEnvelopeError("bad-request", "identity renewal requires a name and public key", undefined, "not-executed");
  const name = identityAlias(services.managerName, input.name);
  const publicKey = input.publicKey;
  const minter = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
  const record = store.get(name);
  if (!record) throw new EpEnvelopeError("not-found", `identity ${name} has no reservation`, undefined, "not-executed");
  if (record.minter !== minter) throw new EpEnvelopeError("permission-denied", `identity ${name} is owned by another minter`, undefined, "not-executed");
  if (record.publicKey !== publicKey) throw new EpEnvelopeError("permission-denied", "identity public key does not match", undefined, "not-executed");
  if (record.terminalizing || record.retiredAt !== undefined || record.issuance?.state !== "issued") throw new EpEnvelopeError("failed-precondition", "identity is not issued or is terminalizing", undefined, "not-executed");
  const existing = services.identityRenewFlights.get(record.lifecycleUid);
  if (existing) return existing;
  const flight = renewIdentityFlight(services, store, record, name, minter, publicKey);
  services.identityRenewFlights.set(record.lifecycleUid, flight);
  try { return await flight; } finally { if (services.identityRenewFlights.get(record.lifecycleUid) === flight) services.identityRenewFlights.delete(record.lifecycleUid); }
}
