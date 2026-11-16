import {
  DEFAULT_SERVER,
  DEV_OWNER,
  deprovisionAgent,
  epAuthBucket,
  managedRetirementOpId,
  mintCreds,
  newIdentity,
  principalKey,
  rejectionText,
  type EvictionResult,
  type LifecycleStateTransport,
  type SpaceAuth,
} from "@cotal-ai/core";
import { makeManagerEndpointEvictionEvidence } from "../endpoint-evict.js";
import {
  readStaticSlot,
  activateStaticLifecycle,
  runStaticTerminal,
} from "../static-lifecycle.js";
import { identityIdleRetireDue } from "../renewal.js";
import { IdentityStore, type IdentityRecord } from "./store.js";
import type { IdentityIssuerContext, IdentityMintResult } from "./commands.js";

const RETIREMENT_RETRY_BASE_MS = 1_000;
const RETIREMENT_RETRY_MAX_MS = 5 * 60_000;
const DEPROVISION_TIMEOUT_MS = 15_000;

export class IdentityRetirementBackoff {
  readonly #failures = new Map<string, number>();

  nextDelay(lifecycleUid: string): number {
    const failures = (this.#failures.get(lifecycleUid) ?? 0) + 1;
    this.#failures.set(lifecycleUid, failures);
    return Math.min(RETIREMENT_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 9), RETIREMENT_RETRY_MAX_MS);
  }

  reset(lifecycleUid: string): void {
    this.#failures.delete(lifecycleUid);
  }
}

export interface IdentityRetirementServices {
  readonly identityStore?: IdentityStore;
  readonly auth?: SpaceAuth;
  readonly identityMintFlights: Map<string, Promise<IdentityMintResult>>;
  readonly identityRenewFlights: Map<string, Promise<IdentityMintResult>>;
  readonly staticReconcileStopping: boolean;
  readonly managerLifecycleUid: string;
  readonly managerInstanceId: string;
  readonly space: string;
  readonly servers?: string;
  readonly staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
  readonly retiredPrincipals: Set<string>;
  readonly identityRetirementClock: () => number;
  withLifecycleExecutor<T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (transport: LifecycleStateTransport) => Promise<T>): Promise<T>;
  withIssuer<T>(fn: (issuer: IdentityIssuerContext) => Promise<T>): Promise<T>;
}

export async function waitForIdentityFlights(services: Pick<IdentityRetirementServices, "identityMintFlights" | "identityRenewFlights">, lifecycleUid: string): Promise<void> {
  const mint = services.identityMintFlights.get(lifecycleUid);
  if (mint) await mint.catch(() => {});
  const renewal = services.identityRenewFlights.get(lifecycleUid);
  if (renewal) await renewal.catch(() => {});
}

/** One single-flight retirement sweep with bounded exponential retry delays per identity UID. */
export class IdentityRetirementDriver {
  #sweep?: Promise<void>;
  #rerunAfterSweep = false;
  readonly #inFlight = new Set<string>();
  readonly #backoff = new IdentityRetirementBackoff();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #dueTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly services: () => IdentityRetirementServices) {}

  recheckIdentityRetirements(): Promise<void> {
    if (this.#sweep) {
      this.#rerunAfterSweep = true;
      return this.#sweep;
    }
    const flight = driveIdentityRetirements(this.services(), this);
    this.#sweep = flight;
    void flight.finally(() => {
      if (this.#sweep !== flight) return;
      this.#sweep = undefined;
      if (this.#rerunAfterSweep) {
        this.#rerunAfterSweep = false;
        queueMicrotask(() => void this.recheckIdentityRetirements().catch((error) => console.error(`identity retirement sweep: ${rejectionText(error)}`)));
      }
    }).catch(() => {});
    return flight;
  }

  stop(): void {
    for (const timer of [...this.#retryTimers.values(), ...this.#dueTimers.values()]) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#dueTimers.clear();
  }

  isWaiting(lifecycleUid: string): boolean {
    return this.#retryTimers.has(lifecycleUid) || this.#dueTimers.has(lifecycleUid);
  }

  scheduleDue(lifecycleUid: string, dueAtMs: number): void {
    const delayMs = Math.max(0, dueAtMs - Date.now());
    const previous = this.#dueTimers.get(lifecycleUid);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#dueTimers.delete(lifecycleUid);
      void this.recheckIdentityRetirements().catch((error) => console.error(`identity retirement sweep: ${rejectionText(error)}`));
    }, delayMs);
    timer.unref?.();
    this.#dueTimers.set(lifecycleUid, timer);
  }
  scheduleRetry(lifecycleUid: string, name: string, error: unknown): void {
    const delayMs = this.#backoff.nextDelay(lifecycleUid);
    console.error(`identity retirement ${name}: ${rejectionText(error)}; retrying in ${delayMs} ms`);
    clearTimeout(this.#retryTimers.get(lifecycleUid));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(lifecycleUid);
      void this.recheckIdentityRetirements().catch((retryError) => console.error(`identity retirement sweep: ${rejectionText(retryError)}`));
    }, delayMs);
    timer.unref?.();
    this.#retryTimers.set(lifecycleUid, timer);
  }

  completed(lifecycleUid: string): void {
    this.#backoff.reset(lifecycleUid);
    clearTimeout(this.#retryTimers.get(lifecycleUid));
    clearTimeout(this.#dueTimers.get(lifecycleUid));
    this.#retryTimers.delete(lifecycleUid);
    this.#dueTimers.delete(lifecycleUid);
  }


  isInFlight(lifecycleUid: string): boolean {
    return this.#inFlight.has(lifecycleUid);
  }

  start(lifecycleUid: string): void {
    this.#inFlight.add(lifecycleUid);
  }

  finish(lifecycleUid: string): void {
    this.#inFlight.delete(lifecycleUid);
  }

}

export async function driveIdentityRetirements(services: IdentityRetirementServices, driver: IdentityRetirementDriver): Promise<void> {
  const store = services.identityStore;
  if (!store || !services.auth || services.staticReconcileStopping) return;
  for (const row of store.list()) {
    if (driver.isInFlight(row.lifecycleUid)) continue;
    try {
      await driveIdentityRetirementRow(services, store, row, driver);
    } catch (error) {
      try { store.recordRetirementError(row.name, row.minter, row.lifecycleUid, rejectionText(error)); }
      catch (recordError) { error = recordError; }
      driver.scheduleRetry(row.lifecycleUid, row.name, error);
    }
  }
}

async function driveIdentityRetirementRow(services: IdentityRetirementServices, store: IdentityStore, row: IdentityRecord, driver: IdentityRetirementDriver): Promise<void> {
  if (driver.isWaiting(row.lifecycleUid)) return;
  if (!row.terminalizing && row.retiredAt === undefined && identityIdleRetireDue(
    Math.max(row.issuance?.exp ?? 0, row.renewal?.exp ?? 0, Math.floor(row.touchedAt / 1000)),
    Math.floor(services.identityRetirementClock() / 1000),
  )) {
    store.latchRetirement(row.name, row.minter, row.lifecycleUid);
    row.terminalizing = true;
  }
  if (!row.terminalizing || row.retiredAt !== undefined) return;
  driver.start(row.lifecycleUid);
  try { await retireIdentity(services, store, row, driver); }
  finally { driver.finish(row.lifecycleUid); }

}

async function retireIdentity(services: IdentityRetirementServices, store: IdentityStore, row: IdentityRecord, driver: IdentityRetirementDriver): Promise<void> {
  await waitForIdentityFlights(services, row.lifecycleUid);
  const current = store.recordRetirementExpiry(row.name, row.minter, row.lifecycleUid);
  const dueAt = ((current.retirementExpiry ?? 0) + 61) * 1000;
  if (services.identityRetirementClock() < dueAt) {
    driver.scheduleDue(current.lifecycleUid, dueAt);
    return;
  }
  if (!current.publicKey) {
    store.retire(current.name, current.minter, current.lifecycleUid, current.issuance?.generation);
  } else {
    const actor = current.publicKey;
    await runIdentityRetirement(services, current, actor);
    store.retire(current.name, current.minter, current.lifecycleUid, current.issuance?.generation);
    services.retiredPrincipals.add(principalKey(DEV_OWNER, actor).key);
  }
  driver.completed(current.lifecycleUid);
}
async function runIdentityRetirement(services: IdentityRetirementServices, current: IdentityRecord, actor: string): Promise<void> {
  await services.withLifecycleExecutor({ owner: DEV_OWNER, actor, lifecycleUid: current.lifecycleUid, alias: current.name }, async (transport) => {
    const slot = await readStaticSlot(transport, DEV_OWNER, current.name);
    if (!slot) await activateStaticLifecycle(transport, {
      owner: DEV_OWNER, alias: current.name, actor, lifecycleUid: current.lifecycleUid,
      managerInstance: services.managerLifecycleUid, ownerInstanceId: services.managerInstanceId,
    });
    await runStaticTerminal(transport, {
      owner: DEV_OWNER, alias: current.name, actor, lifecycleUid: current.lifecycleUid,
      opId: managedRetirementOpId(current.lifecycleUid), managerInstance: services.managerInstanceId,
      managerProcessUid: services.managerLifecycleUid,
    }, {
      evict: services.staticLifecycleEvict ?? makeManagerEndpointEvictionEvidence({
        space: services.space, servers: services.servers ?? DEFAULT_SERVER, auth: services.auth!,
        log: (line) => console.error(line), unreachableWaitMs: DEPROVISION_TIMEOUT_MS,
      }),
      log: (line) => console.error(`identity retirement ${current.name}: ${line}`),
      cleanup: () => cleanupIdentityAuthority(services, current, actor),
    });
  });
}

async function cleanupIdentityAuthority(services: IdentityRetirementServices, current: IdentityRecord, actor: string): Promise<void> {
  await services.withIssuer((issuer) => issuer.store.retireSource({ space: services.space, bucket: epAuthBucket(services.space), key: `cred.${current.lifecycleUid}` }));
  const creds = await mintCreds(services.auth!, newIdentity(), "deprovisioner", {
    deprovisionTarget: { principal: actor, lifecycleUid: current.lifecycleUid, memberChannels: [] },
  });
  await deprovisionAgent({ servers: services.servers ?? DEFAULT_SERVER, space: services.space, targetId: actor,
    lifecycleUid: current.lifecycleUid, memberChannels: [], creds });
}
