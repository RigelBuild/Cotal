import { epcredRowKey, parseLedgerRow, type CredentialLedgerRow } from "./lifecycle-state.js";
import type { EpServeLedgerRow } from "./endpoint-service.js";

type FamilyRow = Pick<CredentialLedgerRow, "credentialId" | "holderPrincipal" | "state" | "exp" | "sourceChain" | "serviceConnection">;
export interface ManagerRegistrationFamilyReply { complete: true; rows: FamilyRow[] }

export function parseManagerRegistrationFamilyReply(data: Uint8Array, instanceId: string): EpServeLedgerRow[] {
  const raw: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => k !== "complete" && k !== "rows") ||
      !("complete" in raw) || raw.complete !== true || !("rows" in raw) || !Array.isArray(raw.rows))
    throw new Error("invalid manager registration family reply");
  return raw.rows.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(k => !["credentialId", "holderPrincipal", "state", "exp", "sourceChain", "serviceConnection"].includes(k)) ||
        !("credentialId" in value) || typeof value.credentialId !== "string")
      throw new Error("invalid manager registration family row");
    const key = epcredRowKey("manager", instanceId, value.credentialId);
    const row = parseLedgerRow(new TextEncoder().encode(JSON.stringify({ ...value, endpoint: "manager", lifecycleUid: instanceId })), key);
    return { credentialId: row.credentialId, credentialKey: row.serviceConnection?.userNkey ?? "", holderPrincipal: row.holderPrincipal,
      ...(row.serviceConnection ? { serviceConnection: row.serviceConnection } : {}), endpoint: "manager", lifecycleUid: instanceId,
      sourceChain: row.sourceChain, state: row.state, exp: row.exp, generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 };
  });
}
