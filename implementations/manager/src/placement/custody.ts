import { createHash, randomBytes } from "node:crypto";
import { assertLifecycleToken, type SecretStore } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";

interface PlacementActorTokenIdentity {
  space: string;
  instanceId: string;
  actor: string;
  lifecycleUid: string;
}

interface PlacementActorTokenRecord extends PlacementActorTokenIdentity {
  v: 1;
  actorToken: string;
  actorTokenHash: string;
}

/** Generate or recover the manager-private actorToken for one placement lifecycle.
 * Hosted placement MUST use an injected SecretStore that encrypts values at rest (for example, its
 * KMS/Vault adapter); the default FsSecretStore only protects filesystem permissions. The raw token
 * is returned only to trusted launch composition, while placement/auth requests use its digest. */
export async function prepareActorToken(args: {
  store: SecretStore;
  space: string;
  instanceId: string;
  actor: string;
  lifecycleUid: string;
}): Promise<{ actorToken: string; actorTokenHash: string }> {
  const identity = placementActorTokenIdentity(args);
  const key = placementActorTokenKey(identity);
  const existing = await args.store.get(key);
  if (existing !== undefined) return placementActorTokenResult(existing, identity);

  const candidate = placementActorTokenRecord(identity, randomBytes(32).toString("base64url"));
  const created = await args.store.create(key, JSON.stringify(candidate));
  // A false return is a normal concurrent winner. Both paths read and validate the durable value;
  // returning the candidate here could give Auth a hash for a token it did not persist.
  const stored = await args.store.get(key);
  if (stored === undefined)
    throw new Error(created
      ? "placement actorToken custody disappeared before it could be read"
      : "placement actorToken custody winner disappeared before it could be read");
  return placementActorTokenResult(stored, identity);
}

function placementActorTokenResult(raw: string, identity: PlacementActorTokenIdentity): { actorToken: string; actorTokenHash: string } {
  const record = parsePlacementActorTokenRecord(raw);
  if (!samePlacementActorTokenIdentity(record, identity))
    throw new Error("placement actorToken custody belongs to another manager or lifecycle");
  return { actorToken: record.actorToken, actorTokenHash: record.actorTokenHash };
}

/** Remove only this manager's exact lifecycle-scoped actorToken after enrollment retirement. */
export async function retireActorToken(args: {
  store: SecretStore;
  space: string;
  instanceId: string;
  actor: string;
  lifecycleUid: string;
}): Promise<void> {
  const identity = placementActorTokenIdentity(args);
  await args.store.delete(placementActorTokenKey(identity));
}

function placementActorTokenIdentity(args: PlacementActorTokenIdentity): PlacementActorTokenIdentity {
  if (!/^[A-Za-z0-9_.-]+$/.test(args.actor))
    throw new Error("placement actor name is invalid");
  spaceKey(args.space);
  assertLifecycleToken(args.instanceId, "manager instanceId");
  assertLifecycleToken(args.lifecycleUid, "placement lifecycleUid");
  return {
    space: args.space,
    instanceId: args.instanceId,
    actor: args.actor,
    lifecycleUid: args.lifecycleUid,
  };
}

function placementActorTokenKey(identity: PlacementActorTokenIdentity): string {
  const actorKey = Buffer.from(identity.actor, "utf8").toString("hex");
  return `manager/placement-tokens/${spaceKey(identity.space)}/${identity.instanceId}/${actorKey}/${identity.lifecycleUid}.json`;
}

function placementActorTokenRecord(
  identity: PlacementActorTokenIdentity,
  actorToken: string,
): PlacementActorTokenRecord {
  return {
    v: 1,
    ...identity,
    actorToken,
    actorTokenHash: `sha256:${createHash("sha256").update(actorToken, "utf8").digest("hex")}`,
  };
}

function parsePlacementActorTokenRecord(raw: string): PlacementActorTokenRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("placement actorToken custody record is unreadable; refusing to replace its token");
  }
  if (!isPlacementActorTokenRecord(value))
    throw new Error("placement actorToken custody record is invalid; refusing to replace its token");
  const { actorToken, actorTokenHash } = value;
  if (`sha256:${createHash("sha256").update(actorToken, "utf8").digest("hex")}` !== actorTokenHash)
    throw new Error("placement actorToken custody digest does not match its token; refusing recovery");
  return value;
}

function isPlacementActorTokenRecord(value: unknown): value is PlacementActorTokenRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7 &&
    record.v === 1 &&
    typeof record.space === "string" &&
    typeof record.instanceId === "string" && /^[a-z0-9]{26,32}$/.test(record.instanceId) &&
    typeof record.actor === "string" && /^[A-Za-z0-9_.-]+$/.test(record.actor) &&
    typeof record.lifecycleUid === "string" && /^[a-z0-9]{26,32}$/.test(record.lifecycleUid) &&
    typeof record.actorToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.actorToken) &&
    typeof record.actorTokenHash === "string" && /^sha256:[a-f0-9]{64}$/.test(record.actorTokenHash);
}

function samePlacementActorTokenIdentity(
  a: PlacementActorTokenIdentity,
  b: PlacementActorTokenIdentity,
): boolean {
  return a.space === b.space && a.instanceId === b.instanceId && a.actor === b.actor && a.lifecycleUid === b.lifecycleUid;
}
