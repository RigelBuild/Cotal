import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  credRowKey,
  DEV_OWNER,
  invokeCommand,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  parseLedgerRow,
  principalKey,
  resolveService,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  type LifecycleStateTransport,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import { IdentityStore } from "../src/identity/store.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { readStaticSlot } from "../src/static-lifecycle.js";
import { bootDeliveryDaemon, type DeliveryDaemon } from "./_boot-delivery.js";

type LifecyclePin = { owner: string; actor: string; lifecycleUid: string; alias: string };
type LifecycleExecutor = <T>(pin: LifecyclePin, fn: (transport: LifecycleStateTransport) => Promise<T>) => Promise<T>;
type ManagerInternals = {
  identityStore: IdentityStore;
  withLifecycleExecutor: LifecycleExecutor;
  identityRetirementClock: () => number;
  recheckIdentityRetirements(): Promise<void>;
  managerServeIdentity?: unknown;
  staticReconcileSweepsInFlight: number;
  staticReconcileLastSweep?: { completedAt?: string };
};

function internals(manager: Manager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function isActiveSlotWithCredential(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "phase" in value && value.phase === "active" && "credentialIds" in value &&
    Array.isArray(value.credentialIds) && value.credentialIds.length > 0;
}

async function waitForStartupSweep(manager: Manager): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = internals(manager);
    if (state.staticReconcileSweepsInFlight === 0 && state.staticReconcileLastSweep?.completedAt !== undefined) return;
    await delay(10);
  }
  throw new Error("manager startup static-slot sweep did not finish");
}

const space = `mint-replay-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const managerOptions = { space, servers, runtime: "pty" as const, workspaceRoot, seatMintCap: 16 };
let manager = new Manager(managerOptions);
let nc: NatsConnection | undefined;
let delivery: DeliveryDaemon | undefined;
let epoch = 0;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: { kind: "injected", coordinate: "identity-mint-replay-smoke" } });
  await manager.start();
  await waitForStartupSweep(manager);
  const minter = newIdentity();
  const caller = { owner: DEV_OWNER, actor: minter.id, uid: mintLifecycleUid() };
  const callerCreds = await mintCreds(auth, minter, "agent", {
    principal: caller,
    lifecycleUid: caller.uid,
    endpointCapabilities: ["identity-reserve", "identity-mint", "identity-retire"].map((command) => ({ endpoint: MANAGER_ENDPOINT, command })),
  });
  nc = await connect({ servers, ...standaloneConnectOpts({ creds: callerCreds, tls: false }), maxReconnectAttempts: 0 });
  let service = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
  const callOptions = { currentEpoch: async () => epoch };

  const restartManager = async (): Promise<void> => {
    await manager.stop({ withAgents: true });
    manager = new Manager(managerOptions);
    await manager.start();
    epoch++;
    service = await resolveService(nc!, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
    await waitForStartupSweep(manager);
  };
  const reserve = async (slug: string): Promise<{ name: string; lifecycleUid: string }> => {
    const result = await invokeCommand(nc!, space, service, "identity-reserve", { name: slug }, callOptions);
    assert.equal(result.reply.ok, true, JSON.stringify(result.reply));
    const data = result.reply.data;
    if (typeof data !== "object" || data === null || !("name" in data) || typeof data.name !== "string" ||
        !("lifecycleUid" in data) || typeof data.lifecycleUid !== "string")
      throw new Error("identity-reserve returned malformed data");
    return { name: data.name, lifecycleUid: data.lifecycleUid };
  };
  const mintInput = (slug: string, lifecycleUid: string, publicKey: string) => ({ name: slug, lifecycleUid, publicKey });
  const slotFor = (alias: string, lifecycleUid: string, actor: string) => internals(manager).withLifecycleExecutor(
    { owner: DEV_OWNER, actor, lifecycleUid, alias },
    (transport) => readStaticSlot(transport, DEV_OWNER, alias),
  );
  const assertReplayConverged = async (alias: string, lifecycleUid: string, actor: string): Promise<void> => {
    const identity = internals(manager).identityStore.get(alias);
    assert.equal(identity?.issuance?.state, "issued", "replay must persist the issued identity");
    const credentialId = identity?.issuance?.credentialId;
    assert.ok(credentialId, "replay must record the credential id on the identity");
    const slot = await slotFor(alias, lifecycleUid, actor);
    assert.ok(slot, "replay must leave a static slot");
    assert.equal(slot.row.phase, "active", "replay must activate the static slot");
    assert.ok(slot.row.credentialIds.includes(credentialId), "the active slot must record the issued credential");
    const key = credRowKey(lifecycleUid, credentialId);
    const ledger = await internals(manager).withLifecycleExecutor(
      { owner: DEV_OWNER, actor, lifecycleUid, alias },
      (transport) => transport.getAuth(key),
    );
    assert.ok(ledger && ledger.operation === "PUT", "replay must leave the credential ledger row");
    assert.equal(parseLedgerRow(ledger.value, key).state, "active");
  };

  // Window A: the durable pending issuance is written, then this manager incarnation dies before
  // activateStaticLifecycle can write the provisioning slot.
  const pendingReservation = await reserve("crash-pending");
  const pendingSeat = newIdentity();
  const pendingInput = mintInput("crash-pending", pendingReservation.lifecycleUid, pendingSeat.id);
  const pendingStore = internals(manager).identityStore;
  const transition = pendingStore.transition.bind(pendingStore);
  let pendingCrashInjected = false;
  pendingStore.transition = (...args) => {
    const result = transition(...args);
    if (!pendingCrashInjected && args[0] === pendingReservation.name && args[4].state === "pending") {
      pendingCrashInjected = true;
      throw new Error("injected crash after pending issuance transition");
    }
    return result;
  };
  const pendingFailure = await invokeCommand(nc, space, service, "identity-mint", pendingInput, callOptions);
  pendingStore.transition = transition;
  assert.equal(pendingFailure.reply.ok, false, "the injected crash must interrupt the first mint");
  assert.equal(pendingCrashInjected, true);
  assert.equal(internals(manager).identityStore.get(pendingReservation.name)?.issuance?.state, "pending");
  assert.equal(await slotFor(pendingReservation.name, pendingReservation.lifecycleUid, pendingSeat.id), undefined,
    "the crash must occur before a static slot exists");
  await restartManager();
  const pendingReplay = await invokeCommand(nc, space, service, "identity-mint", pendingInput, callOptions);
  assert.equal(pendingReplay.reply.ok, true, JSON.stringify(pendingReplay.reply));
  await assertReplayConverged(pendingReservation.name, pendingReservation.lifecycleUid, pendingSeat.id);
  console.log("PASS replay converges after pending transition before activation");

  // Window B: the credential and ledger row exist and the slot CAS to active lands, but the
  // process dies before IdentityStore.transition(pending -> issued).
  const activeReservation = await reserve("crash-active");
  const activeSeat = newIdentity();
  const activeInput = mintInput("crash-active", activeReservation.lifecycleUid, activeSeat.id);
  const activeControl = internals(manager);
  const originalExecutor = activeControl.withLifecycleExecutor.bind(manager);
  let activeCrashInjected = false;
  activeControl.withLifecycleExecutor = async <T>(pin: LifecyclePin, fn: (transport: LifecycleStateTransport) => Promise<T>): Promise<T> =>
    originalExecutor(pin, async (transport) => {
      const updateRecord = transport.updateRecord.bind(transport);
      transport.updateRecord = async (key, value, revision) => {
        const nextRevision = await updateRecord(key, value, revision);
        if (!activeCrashInjected && pin.alias === activeReservation.name && isActiveSlotWithCredential(value)) {
          activeCrashInjected = true;
          throw new Error("injected crash after active slot CAS");
        }
        return nextRevision;
      };
      return fn(transport);
    });
  const activeFailure = await invokeCommand(nc, space, service, "identity-mint", activeInput, callOptions);
  activeControl.withLifecycleExecutor = originalExecutor;
  assert.equal(activeFailure.reply.ok, false, "the injected crash must interrupt the first mint response");
  assert.equal(activeCrashInjected, true);
  assert.equal(internals(manager).identityStore.get(activeReservation.name)?.issuance?.state, "pending");
  const activeSlotAtCrash = await slotFor(activeReservation.name, activeReservation.lifecycleUid, activeSeat.id);
  assert.equal(activeSlotAtCrash?.row.phase, "active", "the crash must land after the slot CAS");
  await restartManager();
  const activeReplay = await invokeCommand(nc, space, service, "identity-mint", activeInput, callOptions);
  assert.equal(activeReplay.reply.ok, true, JSON.stringify(activeReplay.reply));
  await assertReplayConverged(activeReservation.name, activeReservation.lifecycleUid, activeSeat.id);
  console.log("PASS replay converges after active slot CAS before issued transition");

  // Window C: activation completes with a provisioning slot, then this process dies before the
  // provisioner/issuer can mint. The successor's boot sweep must preserve the pending identity.
  const bootReservation = await reserve("crash-boot");
  const bootSeat = newIdentity();
  const bootInput = mintInput("crash-boot", bootReservation.lifecycleUid, bootSeat.id);
  const bootControl = internals(manager);
  const bootExecutor = bootControl.withLifecycleExecutor.bind(manager);
  let activationCrashInjected = false;
  bootControl.withLifecycleExecutor = async <T>(pin: LifecyclePin, fn: (transport: LifecycleStateTransport) => Promise<T>): Promise<T> =>
    bootExecutor(pin, async (transport) => {
      const result = await fn(transport);
      if (!activationCrashInjected && pin.alias === bootReservation.name &&
          bootControl.identityStore.get(bootReservation.name)?.issuance?.state === "pending") {
        const slot = await readStaticSlot(transport, DEV_OWNER, bootReservation.name);
        if (slot?.row.phase === "provisioning" && slot.row.credentialIds.length === 0) {
          activationCrashInjected = true;
          throw new Error("injected crash after activation before mint");
        }
      }
      return result;
    });
  const bootFailure = await invokeCommand(nc, space, service, "identity-mint", bootInput, callOptions);
  bootControl.withLifecycleExecutor = bootExecutor;
  assert.equal(bootFailure.reply.ok, false, "the injected crash must interrupt the first mint");
  assert.equal(activationCrashInjected, true);
  const provisioningAtCrash = await slotFor(bootReservation.name, bootReservation.lifecycleUid, bootSeat.id);
  assert.equal(provisioningAtCrash?.row.phase, "provisioning");
  await restartManager();
  const afterBootSweep = await slotFor(bootReservation.name, bootReservation.lifecycleUid, bootSeat.id);
  const bootReplay = await invokeCommand(nc, space, service, "identity-mint", bootInput, callOptions);
  if (bootReplay.reply.ok) {
    await assertReplayConverged(bootReservation.name, bootReservation.lifecycleUid, bootSeat.id);
    console.log("PASS boot sweep preserves activation-before-mint crash for replay");
  } else {
    console.error(`FAIL boot sweep left slot ${afterBootSweep?.row.phase ?? "missing"}; replay failed: ${JSON.stringify(bootReplay.reply)}`);
  }
  const bootSweepReplayFailure = bootReplay.reply.ok
    ? undefined
    : `boot sweep left slot ${afterBootSweep?.row.phase ?? "missing"}; replay failed: ${JSON.stringify(bootReplay.reply)}`;

  // A bound pending identity with no slot is a valid retirement input. Retirement waits through its
  // issuance expiry, then settles the identity and its newly-created terminal slot.
  const noSlotReservation = await reserve("retire-no-slot");
  const noSlotSeat = newIdentity();
  const noSlotStore = internals(manager).identityStore;
  noSlotStore.bindPublicKey(noSlotReservation.name, principalKey(caller.owner, caller.actor).key, noSlotReservation.lifecycleUid, noSlotSeat.id);
  const now = Math.floor(Date.now() / 1000);
  const noSlotIssuance = {
    generation: "c".repeat(32),
    iat: now,
    exp: now + 3600,
    acceptedToken: "d".repeat(32),
    issuanceId: mintLifecycleUid(),
    state: "pending" as const,
  };
  noSlotStore.transition(noSlotReservation.name, principalKey(caller.owner, caller.actor).key, noSlotReservation.lifecycleUid, undefined, noSlotIssuance);
  assert.equal(await slotFor(noSlotReservation.name, noSlotReservation.lifecycleUid, noSlotSeat.id), undefined,
    "retirement fixture must have no static slot");
  const retirementControl = internals(manager);
  const normalRetirementClock = retirementControl.identityRetirementClock;
  retirementControl.identityRetirementClock = () => (noSlotIssuance.exp + 61) * 1000;
  const retirement = await invokeCommand(nc, space, service, "identity-retire", { name: "retire-no-slot" }, callOptions);
  assert.equal(retirement.reply.ok, true, JSON.stringify(retirement.reply));
  await retirementControl.recheckIdentityRetirements();
  retirementControl.identityRetirementClock = normalRetirementClock;
  assert.equal(noSlotStore.get(noSlotReservation.name)?.issuance?.state, "retired");
  assert.ok(noSlotStore.get(noSlotReservation.name)?.retiredAt);
  const retiredSlot = await slotFor(noSlotReservation.name, noSlotReservation.lifecycleUid, noSlotSeat.id);
  assert.equal(retiredSlot?.row.phase, "retired");
  console.log("PASS retirement settles a bound identity that had no static slot");

  // N simultaneous manager requests against a fresh manager's cap K must persist exactly K grants.
  await manager.stop({ withAgents: true });
  const capRoot = join(dir, "cap-ws");
  mkdirSync(join(capRoot, ".cotal"), { recursive: true });
  saveSpaceAuth(authDir(capRoot), auth);
  const cap = 3;
  const count = 9;
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: capRoot, seatMintCap: cap });
  await manager.start();
  epoch++;
  service = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
  await waitForStartupSweep(manager);
  const parallelService = service;
  const capCallOptions = { currentEpoch: async () => 0 };
  const concurrent = await Promise.all(Array.from({ length: count }, (_, index) =>
    invokeCommand(nc!, space, parallelService, "identity-reserve", { name: `parallel-${index}` }, capCallOptions)));
  const grants = concurrent.filter((result) => result.reply.ok);
  const refusals = concurrent.filter((result) => !result.reply.ok);
  assert.equal(refusals.length, count - cap);
  assert.ok(refusals.every((result) => result.reply.error?.code === "resource-exhausted"),
    "every losing parallel reservation must be refused by the cap");
  const persisted = internals(manager).identityStore.list().filter((row) => row.minter === principalKey(caller.owner, caller.actor).key);
  assert.equal(persisted.length, cap, "the identity store must persist exactly the cap's grants");
  console.log("PASS parallel reserves grant exactly the configured cap");
  if (bootSweepReplayFailure !== undefined) process.exitCode = 1;
  console.log("identity mint replay smoke passed");
} finally {
  if (nc) await nc.close();
  await manager.stop({ withAgents: true });
  await delivery?.stop();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}


