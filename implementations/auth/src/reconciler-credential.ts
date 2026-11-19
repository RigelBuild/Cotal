/**
 * The reconciler's standing credential, issued and renewed by auth. Auth fixes the caller triple
 * (owner, actor, uid) and the nkey at first issue. Every renewal re-mints for that same triple and
 * nkey, and writes the user credential to the reconciler Secret. The signer seed never leaves auth.
 */
import {
  armFixedRenewal,
  credsClaims,
  EpEnvelopeError,
  fixedRenewalPointMs,
  jitteredBackoffMs,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  type Identity,
  type SecretStore,
  type SpaceAuth,
} from "@cotal-ai/core";
import { spaceSegment } from "@cotal-ai/workspace";

/** The reconciler's caller triple. It is fixed at first issue; every renewal must present it again. */
export interface ReconcilerCaller {
  owner: string;
  actor: string;
  uid: string;
}

/** Auth-owned state for the one reconciler credential: its caller triple and the nkey every renewal
 *  reuses. Stored apart from the Secret, which holds only the user credential. */
export interface ReconcilerRecord {
  caller: ReconcilerCaller;
  identity: Identity;
}

export interface ReconcilerRecordStore {
  load(): Promise<ReconcilerRecord | undefined>;
  /** Create the record. Refuses with `conflict` when one already exists. */
  save(record: ReconcilerRecord): Promise<void>;
}

/** The Secret key the reconciler reads its caller credential from. Other keys in the Secret belong
 *  to other writers; auth patches only this one. */
export const RECONCILER_CREDS_KEY = "caller-credential";

/** The fixed actor of the reconciler caller. */
const RECONCILER_ACTOR = "reconciler";

/** A minted credential's issued-at and expiry, in unix seconds. */
export interface ReconcilerIssued {
  iat: number;
  exp: number;
}

/** The claims the due-check reads from a held credential. */
interface HeldClaims {
  sub: string;
  iat: number;
  exp: number;
}

export interface ReconcilerCredentialAuthority {
  /** First issue. Records the caller triple and nkey, then writes the credential. */
  issue(caller: ReconcilerCaller): Promise<ReconcilerIssued>;
  /** Re-mint for the recorded triple and nkey. Any other triple is refused before anything is signed. */
  renew(caller: ReconcilerCaller): Promise<ReconcilerIssued>;
}

export interface ReconcilerCredentialOptions {
  auth: SpaceAuth;
  secrets: SecretStore;
  records: ReconcilerRecordStore;
}

export function createReconcilerCredentialAuthority(opts: ReconcilerCredentialOptions): ReconcilerCredentialAuthority {
  const mint = async (identity: Identity, caller: ReconcilerCaller): Promise<ReconcilerIssued> => {
    const creds = await mintCreds(opts.auth, identity, "reconciler", {
      principal: { owner: caller.owner, actor: caller.actor },
      lifecycleUid: caller.uid,
      reconciler: { owner: caller.owner, actor: caller.actor, uid: caller.uid },
    });
    const claims = credsClaims(creds);
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number")
      throw new Error("reconciler credential must carry a bounded iat and exp");
    await opts.secrets.put(RECONCILER_CREDS_KEY, creds);
    return { iat: claims.iat, exp: claims.exp };
  };
  return {
    issue: async (caller) => {
      if (await opts.records.load() !== undefined)
        throw new EpEnvelopeError("conflict", "reconciler credential is already issued; renew it for its recorded caller triple");
      const identity = newIdentity();
      const recorded = { owner: caller.owner, actor: caller.actor, uid: caller.uid };
      await opts.records.save({ caller: recorded, identity });
      return mint(identity, recorded);
    },
    renew: async (caller) => {
      const record = await opts.records.load();
      if (record === undefined)
        throw new EpEnvelopeError("failed-precondition", "reconciler credential has not been issued");
      const same = record.caller.owner === caller.owner && record.caller.actor === caller.actor && record.caller.uid === caller.uid;
      if (!same)
        throw new EpEnvelopeError("permission-denied", "reconciler renewal refused: the caller triple does not match the recorded caller triple");
      return mint(record.identity, record.caller);
    },
  };
}

/** Keep the reconciler credential renewed at exactly 75% of each lifetime. Each renewal re-arms from
 *  the new credential's issue and expiry. A failed renewal stops the chain and reports to `onFailure`.
 *  Returns the stop function. */
export function keepReconcilerCredentialRenewed(
  authority: ReconcilerCredentialAuthority,
  caller: ReconcilerCaller,
  issued: ReconcilerIssued,
  onFailure: (error: unknown) => void,
): () => void {
  let stopped = false;
  let cancel: () => void = () => {};
  const arm = (current: ReconcilerIssued): void => {
    if (stopped) return;
    cancel = armFixedRenewal(current.iat * 1000, current.exp * 1000, () => {
      authority.renew(caller).then(arm, onFailure);
    });
  };
  arm(issued);
  return () => {
    stopped = true;
    cancel();
  };
}

/** Auth's own store key for the record behind one reconciler Secret key, one per space and key.
 *  Never stored in the reconciler Secret. */
export function reconcilerRecordKey(space: string, secretKey: string): string {
  return `auth/${spaceSegment(space)}/reconciler-record-${secretKey}.json`;
}

/** The record store over auth's own SecretStore. The record is written once, with an atomic create.
 *  A second create, or any change to a recorded triple or key, is refused rather than overwritten. */
export function secretRecordStore(store: SecretStore, space: string, secretKey: string): ReconcilerRecordStore {
  const key = reconcilerRecordKey(space, secretKey);
  return {
    load: async () => {
      const raw = await store.get(key);
      // SAFETY: the record is auth-private and only `save` writes it, in this same shape.
      return raw === undefined ? undefined : JSON.parse(raw) as ReconcilerRecord;
    },
    save: async (record) => {
      const created = await store.create(key, JSON.stringify(record, null, 2));
      if (!created) throw new EpEnvelopeError("conflict", "reconciler record already exists; refusing to replace the recorded caller triple and nkey");
    },
  };
}

export interface StartReconcilerCredentialOptions {
  space: string;
  auth: SpaceAuth;
  /** The platform owner of this account, from `platformControlOwner`. */
  owner: string;
  /** The store the reconciler Secret is written to. */
  secrets: SecretStore;
  /** Auth's own record of the caller triple and nkey. */
  records: ReconcilerRecordStore;
  log: (line: string) => void;
}

/** Start the reconciler credential without ever failing the caller. One attempt runs in the background
 *  at once: issue when no record exists, else renew when due. Every failure logs and retries with the
 *  same jittered backoff. Once a credential is held, it renews at 75%. Returns the stop function, which
 *  cancels the pending attempt and the renewal timer. */
export function startReconcilerCredential(opts: StartReconcilerCredentialOptions): () => void {
  const authority = createReconcilerCredentialAuthority({ auth: opts.auth, secrets: opts.secrets, records: opts.records });
  let stopped = false;
  let stopRenewal: () => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;

  const schedule = (delayMs: number, run: () => Promise<void>): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      run().catch(onFailure);
    }, delayMs);
    timer.unref();
  };
  const onFailure = (error: unknown): void => {
    opts.log(`reconciler credential failed (${errorText(error)}) - retrying with backoff`);
    schedule(jitteredBackoffMs(failures++, 1_000, 60_000), attempt);
  };
  const hold = (issued: ReconcilerIssued, caller: ReconcilerCaller): void => {
    if (stopped) return;
    failures = 0;
    stopRenewal = keepReconcilerCredentialRenewed(authority, caller, issued, (error) => {
      opts.log(`reconciler credential renewal failed (${errorText(error)}) - retrying with backoff`);
      schedule(jitteredBackoffMs(failures++, 1_000, 60_000), () => renewRecorded(caller));
    });
  };
  const renewRecorded = async (caller: ReconcilerCaller): Promise<void> => {
    hold(await authority.renew(caller), caller);
  };
  const attempt = async (): Promise<void> => {
    const record = await opts.records.load();
    if (record === undefined) {
      const caller: ReconcilerCaller = { owner: opts.owner, actor: RECONCILER_ACTOR, uid: mintLifecycleUid() };
      hold(await authority.issue(caller), caller);
      return;
    }
    const held = await heldIfCurrent(opts.secrets, record);
    hold(held ?? (await authority.renew(record.caller)), record.caller);
  };
  schedule(0, attempt);
  return () => {
    stopped = true;
    stopRenewal();
    clearTimeout(timer);
  };
}

/** The held credential's issue and expiry when it is still current, or undefined when it is missing,
 *  unreadable, past 75% of its lifetime, or not the recorded nkey. Undefined means reissue. */
async function heldIfCurrent(secrets: SecretStore, record: ReconcilerRecord): Promise<ReconcilerIssued | undefined> {
  const claims = readHeldClaims(await secrets.get(RECONCILER_CREDS_KEY));
  if (claims === undefined || claims.sub !== record.identity.id) return undefined;
  if (Date.now() >= fixedRenewalPointMs(claims.iat * 1000, claims.exp * 1000)) return undefined;
  return { iat: claims.iat, exp: claims.exp };
}

/** The held credential's claims, or undefined when the Secret holds no readable bounded credential. */
function readHeldClaims(current: string | undefined): HeldClaims | undefined {
  if (current === undefined) return undefined;
  try {
    const claims = credsClaims(current);
    if (typeof claims.sub !== "string" || typeof claims.iat !== "number" || typeof claims.exp !== "number") return undefined;
    return { sub: claims.sub, iat: claims.iat, exp: claims.exp };
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
