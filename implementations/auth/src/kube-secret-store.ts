/**
 * A SecretStore over one existing Kubernetes Secret, through the API server REST endpoint with the
 * in-cluster ServiceAccount token and cluster CA. It uses only get and merge patch, one key at a
 * time. The reconciler reads the Secret through its own mount, never through this adapter.
 */
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { SecretStore, SecretStoreIdentity } from "@cotal-ai/core";

export const RECONCILER_SECRET_NAMESPACE = "cotal-control";
export const RECONCILER_SECRET_NAME = "reconciler-credentials";
export const IN_CLUSTER_API_BASE = "https://kubernetes.default.svc";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const SA_TOKEN_PATH = `${SA_DIR}/token`;
const SA_CA_PATH = `${SA_DIR}/ca.crt`;

/** Bounded wait on each API call. A timeout counts as a failure and retries with backoff. */
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

/** One HTTP call to the API server. The default verifies the cluster CA. A test passes its own. */
export type KubeTransport = (url: string, call: KubeCall) => Promise<KubeResponse>;

export interface KubeSecretStoreOptions {
  /** API server base URL, for example https://kubernetes.default.svc. */
  apiBase: string;
  namespace: string;
  name: string;
  /** Returns the bearer token. The default reads the mounted ServiceAccount token on each call. */
  token?: () => Promise<string>;
  /** Replaces the default transport. Tests use it; production never sets it. */
  transport?: KubeTransport;
  /** Trust root for the default transport. Defaults to the mounted cluster CA. */
  caPath?: string;
  /** Override for {@link KUBE_CALL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** One read of the Secret: whether it exists, its data (values base64, as the API stores them), and
 *  the resourceVersion a conditional write must still match. */
interface SecretRead {
  exists: boolean;
  data: Record<string, string>;
  resourceVersion: string | undefined;
}

export class KubeSecretStore implements SecretStore {
  readonly identity: SecretStoreIdentity;
  private readonly url: string;
  private readonly ref: string;
  private readonly token: () => Promise<string>;
  private readonly transport: KubeTransport;
  private readonly timeoutMs: number;

  constructor(opts: KubeSecretStoreOptions) {
    this.url = `${opts.apiBase.replace(/\/+$/, "")}/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/secrets/${encodeURIComponent(opts.name)}`;
    this.ref = `${opts.namespace}/${opts.name}`;
    this.identity = { kind: "injected", coordinate: `kube-secret:${this.ref}` };
    this.token = opts.token ?? readServiceAccountToken;
    const caPath = opts.caPath ?? SA_CA_PATH;
    this.transport = opts.transport ?? ((url, call) => httpsTransport(caPath, url, call));
    this.timeoutMs = opts.timeoutMs ?? KUBE_CALL_TIMEOUT_MS;
  }

  async get(key: string): Promise<string | undefined> {
    const current = await this.read();
    const encoded = current.data[key];
    return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
  }

  /** Set one key with a merge patch on `data`. Other keys, labels and annotations stay. The Secret
   *  is provisioned empty by the cluster manifests; auth never creates or replaces it. */
  async put(key: string, value: string): Promise<void> {
    const data = { [key]: Buffer.from(value, "utf8").toString("base64") };
    const res = await this.send("PATCH", this.url, { data }, MERGE_PATCH);
    if (!ok(res.status)) throw new Error(`kube secret ${this.ref} write failed: HTTP ${res.status}`);
  }

  /** Set one key only while it is absent: a merge patch pinned to the read resourceVersion. A loser
   *  gets 409 and resolves false with the winner's value untouched. */
  async create(key: string, value: string): Promise<boolean> {
    const data = { [key]: Buffer.from(value, "utf8").toString("base64") };
    const current = await this.read();
    if (!current.exists) throw new Error(`kube secret ${this.ref} is missing; it is provisioned by the cluster manifests`);
    if (current.data[key] !== undefined) return false;
    const res = await this.send("PATCH", this.url, { metadata: { resourceVersion: current.resourceVersion }, data }, MERGE_PATCH);
    if (res.status === 409) return false;
    if (!ok(res.status)) throw new Error(`kube secret ${this.ref} create failed: HTTP ${res.status}`);
    return true;
  }

  async delete(key: string): Promise<void> {
    const current = await this.read();
    if (current.data[key] === undefined) return;
    const res = await this.send("PATCH", this.url, { data: { [key]: null } }, MERGE_PATCH);
    if (!ok(res.status)) throw new Error(`kube secret ${this.ref} delete failed: HTTP ${res.status}`);
  }

  private async send(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<KubeResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers["content-type"] = contentType;
    const call = this.transport(url, {
      method, headers, timeoutMs: this.timeoutMs,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return bounded(call, this.timeoutMs, `kube ${method} ${this.ref}`);
  }

  private async read(): Promise<SecretRead> {
    const res = await this.send("GET", this.url);
    if (res.status === 404) return { exists: false, data: {}, resourceVersion: undefined };
    if (!ok(res.status)) throw new Error(`kube secret ${this.ref} read failed: HTTP ${res.status}`);
    const secret = JSON.parse(res.body) as { data?: Record<string, string>; metadata?: { resourceVersion?: string } };
    return { exists: true, data: secret.data ?? {}, resourceVersion: secret.metadata?.resourceVersion };
  }
}

const MERGE_PATCH = "application/merge-patch+json";

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Race one call against its bound. A timed-out call rejects, so the caller's retry treats it as a
 *  failure. The timer is cleared when the call settles, so an answered call leaves none armed. */
async function bounded<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readServiceAccountToken(): Promise<string> {
  return (await readFile(SA_TOKEN_PATH, "utf8")).trim();
}

/** The default transport: HTTPS with the cluster CA as the only trust root, and a hard timeout. Node
 *  trusts only public roots by default, so the in-cluster API server refuses without the CA. */
async function httpsTransport(caPath: string, url: string, call: KubeCall): Promise<KubeResponse> {
  const ca = await readFile(caPath, "utf8");
  return new Promise<KubeResponse>((resolve, reject) => {
    const req = httpsRequest(url, { method: call.method, headers: call.headers, ca, timeout: call.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`kube request timed out after ${call.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(call.body);
  });
}
