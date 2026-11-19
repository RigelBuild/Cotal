/**
 * The reconciler's standing credential, issued and renewed by auth. Not implemented yet: every entry
 * point is inert, so the smokes load it and fail on behaviour.
 */
import type { Identity, SecretStore, SpaceAuth } from "@cotal-ai/core";

export interface ReconcilerCaller {
  owner: string;
  actor: string;
  uid: string;
}

export interface ReconcilerRecord {
  caller: ReconcilerCaller;
  identity: Identity;
}

export interface ReconcilerRecordStore {
  load(): Promise<ReconcilerRecord | undefined>;
  save(record: ReconcilerRecord): Promise<void>;
}

export const RECONCILER_CREDS_KEY = "caller-credential";

export interface ReconcilerIssued {
  iat: number;
  exp: number;
}

export interface ReconcilerCredentialAuthority {
  issue(caller: ReconcilerCaller): Promise<ReconcilerIssued>;
  renew(caller: ReconcilerCaller): Promise<ReconcilerIssued>;
}

export interface ReconcilerCredentialOptions {
  auth: SpaceAuth;
  secrets: SecretStore;
  records: ReconcilerRecordStore;
}

export function createReconcilerCredentialAuthority(_opts: ReconcilerCredentialOptions): ReconcilerCredentialAuthority {
  return { issue: async () => ({ iat: 0, exp: 0 }), renew: async () => ({ iat: 0, exp: 0 }) };
}

export function keepReconcilerCredentialRenewed(
  _authority: ReconcilerCredentialAuthority,
  _caller: ReconcilerCaller,
  _issued: ReconcilerIssued,
  _onFailure: (error: unknown) => void,
): () => void {
  return () => {};
}

export function reconcilerRecordKey(space: string, secretKey: string): string {
  return `auth/${space}/reconciler-record-${secretKey}.json`;
}

export function secretRecordStore(_store: SecretStore, _space: string, _secretKey: string): ReconcilerRecordStore {
  return { load: async () => undefined, save: async () => {} };
}

export interface StartReconcilerCredentialOptions {
  space: string;
  auth: SpaceAuth;
  owner: string;
  secrets: SecretStore;
  records: ReconcilerRecordStore;
  log: (line: string) => void;
}

export function startReconcilerCredential(_opts: StartReconcilerCredentialOptions): () => void {
  return () => {};
}
