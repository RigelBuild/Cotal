import { DEV_OWNER, type StaticManagedSlotRow } from "@cotal-ai/core";
import type { IdentityRecord, IdentityStore } from "./store.js";

export function readIdentitySnapshot(store: IdentityStore | undefined): ReadonlyMap<string, IdentityRecord> {
  return new Map((store?.list() ?? []).map((record) => [record.lifecycleUid, record]));
}

export function isAdoptedIdentity(
  row: StaticManagedSlotRow,
  identityByUid: ReadonlyMap<string, IdentityRecord>,
): boolean {
  const record = identityByUid.get(row.lifecycleUid);
  if (record === undefined || record.name !== row.alias || record.publicKey !== row.actor || row.owner !== DEV_OWNER || record.retiredAt !== undefined)
    return false;
  if (record.terminalizing) return false;
  if (record.issuance?.state === "pending")
    return row.phase === "provisioning" || row.phase === "active";
  return record.issuance?.state === "issued" && row.phase === "active" &&
    record.issuance.credentialId !== undefined && row.credentialIds.includes(record.issuance.credentialId);
}
