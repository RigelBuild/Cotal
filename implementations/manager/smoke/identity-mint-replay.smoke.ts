import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth,
  credRowKey,
  DEV_OWNER,
  dmDurable,
  dmStream,
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
  type CotalEndpoint,
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
  identityRuntime: { store: IdentityStore; clock: () => number; driver: { recheckIdentityRetirements(): Promise<void>; start(uid: string): void } };
  withLifecycleExecutor: LifecycleExecutor;
  withProvisioner<T>(fn: (provisioner: CotalEndpoint) => Promise<T>): Promise<T>;
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
    const identity = internals(manager).identityRuntime.store.get(alias);
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
  const pendingStore = internals(manager).identityRuntime.store;
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
  assert.equal(internals(manager).identityRuntime.store.get(pendingReservation.name)?.issuance?.state, "pending");
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
  assert.equal(internals(manager).identityRuntime.store.get(activeReservation.name)?.issuance?.state, "pending");
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
          bootControl.identityRuntime.store.get(bootReservation.name)?.issuance?.state === "pending") {
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

  const expiredReservation = await reserve("crash-expired");
  const expiredSeat = newIdentity();
  const expiredStore = internals(manager).identityRuntime.store;
  const expiredMinter = principalKey(caller.owner, caller.actor).key;
  expiredStore.bindPublicKey(expiredReservation.name, expiredMinter, expiredReservation.lifecycleUid, expiredSeat.id);
  const expiredNow = Math.floor(Date.now() / 1000);
  const expiredIssuance = {
    generation: "e".repeat(32), iat: expiredNow - 3600, exp: expiredNow - 1,
    acceptedToken: "f".repeat(32), issuanceId: mintLifecycleUid(), state: "pending" as const,
  };
  expiredStore.transition(expiredReservation.name, expiredMinter, expiredReservation.lifecycleUid, undefined, expiredIssuance);
  const expiredReplay = await invokeCommand(nc, space, service, "identity-mint", mintInput("crash-expired", expiredReservation.lifecycleUid, expiredSeat.id), callOptions);
  assert.equal(expiredReplay.reply.ok, false, "an expired pending issuance must refuse replay");
  assert.equal(expiredReplay.reply.error?.code, "failed-precondition", JSON.stringify(expiredReplay.reply));
  assert.match(expiredReplay.reply.error?.message ?? "", /retire/);
  assert.equal(expiredStore.get(expiredReservation.name)?.issuance?.state, "pending");
  console.log("PASS replay after pending issuance expiry returns failed-precondition");
  // A bound pending identity with no slot is a valid retirement input. Retirement waits through its
  // issuance expiry, then settles the identity and its newly-created terminal slot.
  const noSlotReservation = await reserve("retire-no-slot");
  const noSlotSeat = newIdentity();
  const noSlotStore = internals(manager).identityRuntime.store;
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
  const normalRetirementClock = retirementControl.identityRuntime.clock;
  retirementControl.identityRuntime.clock = () => (noSlotIssuance.exp + 61) * 1000;
  const retirement = await invokeCommand(nc, space, service, "identity-retire", { name: "retire-no-slot" }, callOptions);
  assert.equal(retirement.reply.ok, true, JSON.stringify(retirement.reply));
  await retirementControl.identityRuntime.driver.recheckIdentityRetirements();
  retirementControl.identityRuntime.clock = normalRetirementClock;
  assert.equal(noSlotStore.get(noSlotReservation.name)?.issuance?.state, "retired");
  assert.ok(noSlotStore.get(noSlotReservation.name)?.retiredAt);
  const retiredSlot = await slotFor(noSlotReservation.name, noSlotReservation.lifecycleUid, noSlotSeat.id);
  assert.equal(retiredSlot?.row.phase, "retired");
  console.log("PASS retirement settles a bound identity that had no static slot");

  // Hold a real mint after DM provisioning while each retirement entry point runs.
  for (const mode of ["command", "sweep"] as const) {
    const slug = `race-${mode}`;
    const reservation = await reserve(slug);
    const seat = newIdentity();
    const control = internals(manager);
    const originalProvisioner = control.withProvisioner.bind(manager);
    let releaseMint!: () => void;
    let signalProvisioned!: () => void;
    const held = new Promise<void>((resolve) => { releaseMint = resolve; });
    const provisioned = new Promise<void>((resolve) => { signalProvisioned = resolve; });
    control.withProvisioner = async <T>(fn: (provisioner: CotalEndpoint) => Promise<T>): Promise<T> =>
      originalProvisioner(async (provisioner) => {
        const provision = provisioner.provisionDmInbox.bind(provisioner);
        provisioner.provisionDmInbox = async (...args) => {
          const result = await provision(...args);
          if (args[2] === reservation.lifecycleUid) { signalProvisioned(); await held; }
          return result;
        };
        return fn(provisioner);
      });
    const mint = invokeCommand(nc, space, service, "identity-mint", mintInput(slug, reservation.lifecycleUid, seat.id), callOptions);
    await provisioned;
    const record = control.identityRuntime.store.get(reservation.name);
    assert.ok(record?.issuance);
    const oldClock = control.identityRuntime.clock;
    const retirementTime = (record.issuance.exp + 61) * 1000;
    control.identityRuntime.clock = () => retirementTime;
    let mintHeld = true;
    let passedBarrierWhileHeld = false;
    let signalSweep!: () => void;
    const sweepStarted = new Promise<void>((resolve) => { signalSweep = resolve; });
    const driver = control.identityRuntime.driver;
    const originalStart = driver.start.bind(driver);
    driver.start = (uid) => { originalStart(uid); if (uid === reservation.lifecycleUid) signalSweep(); };
    const originalExpiry = control.identityRuntime.store.recordRetirementExpiry.bind(control.identityRuntime.store);
    control.identityRuntime.store.recordRetirementExpiry = (...args) => {
      if (args[2] === reservation.lifecycleUid && mintHeld) passedBarrierWhileHeld = true;
      return originalExpiry(...args);
    };
    let retirement: Promise<unknown>;
    if (mode === "command") {
      retirement = invokeCommand(nc, space, service, "identity-retire", { name: slug }, callOptions);
      const latchDeadline = Date.now() + 5_000;
      while (!control.identityRuntime.store.get(reservation.name)?.terminalizing && Date.now() < latchDeadline) await delay(10);
      assert.equal(control.identityRuntime.store.get(reservation.name)?.terminalizing, true);
      void driver.recheckIdentityRetirements();
    } else {
      control.identityRuntime.store.latchRetirement(reservation.name, record.minter, reservation.lifecycleUid);
      retirement = driver.recheckIdentityRetirements();
    }
    await sweepStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    mintHeld = false;
    releaseMint();
    await mint.catch(() => undefined);
    await retirement;
    driver.start = originalStart;
    control.identityRuntime.store.recordRetirementExpiry = originalExpiry;
    assert.equal(passedBarrierWhileHeld, false, `sweep during ${mode} retirement passed the flight barrier while mint was held`);
    await control.identityRuntime.driver.recheckIdentityRetirements();
    control.withProvisioner = originalProvisioner;
    control.identityRuntime.clock = oldClock;
    assert.ok(control.identityRuntime.store.get(reservation.name)?.retiredAt, `${mode} retirement must finish`);
    const probeId = newIdentity();
    const probe = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, probeId, "provisioner"), tls: false }), maxReconnectAttempts: 0 });
    try {
      const jsm = await jetstreamManager(probe);
      let exists = true;
      try { await jsm.consumers.info(dmStream(space), dmDurable(DEV_OWNER, seat.id, reservation.lifecycleUid)); }
      catch (error) {
        if (!(error instanceof JetStreamApiError) || error.code !== JetStreamApiCodes.ConsumerNotFound) throw error;
        exists = false;
      }
      assert.equal(exists, false, `${mode} retirement must remove the DM durable`);
    } finally { await probe.close(); }
    console.log(`PASS ${mode} retirement waits for a mint and removes its DM durable`);
  }

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
  const persisted = internals(manager).identityRuntime.store.list().filter((row) => row.minter === principalKey(caller.owner, caller.actor).key);
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


