import { epcredRowKey, parseLedgerRow } from "./lifecycle-state.js";
import type { EpServeLedgerRow } from "./endpoint-service.js";

export function parseManagerRegistrationFamilyRows(rows: unknown[], instanceId: string): EpServeLedgerRow[] {
  return rows.map((value: unknown) => {
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
