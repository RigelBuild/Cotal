/**
 * A SecretStore backed by one Kubernetes Secret. Not implemented yet: it reads nothing and writes
 * nothing, so the smokes load it and fail on behaviour.
 */
import type { SecretStore, SecretStoreIdentity } from "@cotal-ai/core";

export const RECONCILER_SECRET_NAMESPACE = "cotal-control";
export const RECONCILER_SECRET_NAME = "reconciler-credentials";
export const IN_CLUSTER_API_BASE = "https://kubernetes.default.svc";
export const KUBE_CALL_TIMEOUT_MS = 10_000;

export interface KubeResponse {
  status: number;
  body: string;
}

export interface KubeCall {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type KubeTransport = (url: string, call: KubeCall) => Promise<KubeResponse>;

export interface KubeSecretStoreOptions {
  apiBase: string;
  namespace: string;
  name: string;
  token?: () => Promise<string>;
  transport?: KubeTransport;
  caPath?: string;
  timeoutMs?: number;
}

export class KubeSecretStore implements SecretStore {
  readonly identity: SecretStoreIdentity;
  constructor(opts: KubeSecretStoreOptions) {
    this.identity = { kind: "injected", coordinate: `kube-secret:${opts.namespace}/${opts.name}` };
  }
  async get(_key: string): Promise<string | undefined> { return undefined; }
  async put(_key: string, _value: string): Promise<void> {}
  async create(_key: string, _value: string): Promise<boolean> { return false; }
  async delete(_key: string): Promise<void> {}
}
