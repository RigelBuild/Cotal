/**
 * Broker-enforced ACL checks for the static webhook publisher profile.
 * Run: pnpm smoke:webhook-publisher
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  anycastSubject,
  canonicalBackupStreamConfig,
  channelBucket,
  standaloneConnectOpts,
  chatSubject,
  controlServiceSubject,
  CONTROL_DELIVERY,
  createSpaceAuth,
  DEV_OWNER,
  dmDurable,
  dmStream,
  isReachable,
  lastKvEntries,
  mintCreds,
  newIdentity,
  presenceBucket,
  principalKey,
  serverConfig,
  setupSpaceStreams,
  spacePrefix,
  taskDurable,
  taskStream,
  unicastSubject,
} from "../src/index.js";
import { createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `webhook-pub-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

/** DM and anycast publishes use `jetstream(nc)` with no override (endpoint.ts), so they take the
 *  JetStream client's default request timeout, 5000 ms (`jsbaseclient_api.js`). */
const PUBLISH_TIMEOUT_MS = 5_000;

/** Resolve after `ms`. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Verdict = "allowed" | "denied" | `error: ${string}`;

/** Only a broker permission denial is "denied". A timeout or any other failure is an error, so a
 *  refused request can never pass as allowed. */
function verdictOf(error: unknown): Verdict {
  const message = error instanceof Error ? error.message : String(error);
  return /authorization|permission/i.test(message) ? "denied" : `error: ${message}`;
}

async function request(creds: string, subject: string, id: string): Promise<Verdict> {
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed";
  } catch (error) {
    return verdictOf(error);
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** A real JetStream publish. The PubAck proves the broker stored the message at a sequence. */
async function publish(creds: string, subject: string, id: string): Promise<{ seq: number; stream: string } | Verdict> {
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  try {
    const ack = await jetstream(nc, { timeout: PUBLISH_TIMEOUT_MS }).publish(subject, JSON.stringify({ id: randomUUID() }), { msgID: randomUUID() });
    return { seq: ack.seq, stream: ack.stream };
  } catch (error) {
    return verdictOf(error);
  } finally {
    await nc.drain().catch(() => {});
  }
}

async function subscribeVerdict(creds: string, id: string, subject: string): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  let refused = false;
  void (async () => {
    for await (const event of nc.status()) {
      if (/permission|authorization/i.test(JSON.stringify(event))) refused = true;
    }
  })().catch(() => {});
  const sub = nc.subscribe(subject, { callback: (error) => { if (error) refused = true; } });
  await nc.flush().catch(() => { refused = true; });
  await wait(350);
  try { sub.unsubscribe(); } catch { /* connection is draining */ }
  await nc.drain().catch(() => {});
  return refused ? "denied" : "allowed";
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    ready = await isReachable(servers);
    if (!ready) await wait(100);
  }
  if (!ready) throw new Error("auth nats-server did not come up");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const publisher = newIdentity();
  const profileCreds = await mintCreds(auth, publisher, "webhook-publisher");
  const other = newIdentity();
  const lifecycleUid = "u".repeat(26);
  const dmTarget = dmStream(space);
  const taskTarget = taskStream(space);
  const dmDurableName = dmDurable(DEV_OWNER, publisher.id, lifecycleUid);
  const taskDurableName = taskDurable("builder");
  const control = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, publisher.id);

  // Positive: DM and anycast are stored, proven by a PubAck on the stream each one belongs to.
  const dm = await publish(profileCreds, unicastSubject(space, DEV_OWNER, other.id, DEV_OWNER, publisher.id), publisher.id);
  check("DM send succeeds (PubAck on the DM stream)", typeof dm === "object" && dm.stream === dmTarget && dm.seq > 0, dm);
  const anycast = await publish(profileCreds, anycastSubject(space, "builder", DEV_OWNER, publisher.id), publisher.id);
  check("anycast send succeeds (PubAck on the TASK stream)", typeof anycast === "object" && anycast.stream === taskTarget && anycast.seq > 0, anycast);

  // Positive: the production roster read (open the presence bucket, then a batched Direct Get) must
  // return a list through the profile's own credential, not merely avoid a denial.
  const presenceNc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(profileCreds)), inboxPrefix: `_INBOX_${publisher.id}`, maxReconnectAttempts: 0 });
  let presenceRead: "allowed" | `error: ${string}` = "error: presence read did not run";
  try {
    const roster = await lastKvEntries(await new Kvm(presenceNc).open(presenceBucket(space)));
    presenceRead = Array.isArray(roster) ? "allowed" : "error: roster read returned no list";
  } catch (error) {
    presenceRead = `error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await presenceNc.drain().catch(() => {});
  }
  check("presence read succeeds (the production roster read runs on the profile credential)", presenceRead === "allowed", presenceRead);

  // Negative: publish-only. Each refusal must be a broker permission denial.
  check("fetch from the DM durable is refused", await request(profileCreds, `$JS.API.CONSUMER.MSG.NEXT.${dmTarget}.${dmDurableName}`, publisher.id) === "denied");
  check("fetch from the TASK durable is refused", await request(profileCreds, `$JS.API.CONSUMER.MSG.NEXT.${taskTarget}.${taskDurableName}`, publisher.id) === "denied");
  check("ack on the DM durable is refused", await request(profileCreds, `$JS.ACK.${dmTarget}.${dmDurableName}.1.1.1.0.0`, publisher.id) === "denied");
  check("chat publish is refused", await request(profileCreds, chatSubject(space, DEV_OWNER, publisher.id, "general"), publisher.id) === "denied");
  check("chat subscribe is refused", await subscribeVerdict(profileCreds, publisher.id, `${spacePrefix(space)}.chat.>`) === "denied");
  check("DM subscribe (inst.>) is refused", await subscribeVerdict(profileCreds, publisher.id, `${spacePrefix(space)}.inst.>`) === "denied");
  check("anycast subscribe (svc.>) is refused", await subscribeVerdict(profileCreds, publisher.id, `${spacePrefix(space)}.svc.>`) === "denied");
  check("control service request is refused", await request(profileCreds, control, publisher.id) === "denied");
  check("channel-registry Direct Get is refused", await request(profileCreds, `$JS.API.DIRECT.GET.KV_${channelBucket(space)}`, publisher.id) === "denied");
  check("KV presence write is refused", await request(profileCreds, `$KV.${presenceBucket(space)}.${principalKey(DEV_OWNER, publisher.id).key}`, publisher.id) === "denied");
  check("KV channel-registry write is refused", await request(profileCreds, `$KV.${channelBucket(space)}.${principalKey(DEV_OWNER, publisher.id).key}`, publisher.id) === "denied");
  check("DM stream delete is refused", await request(profileCreds, `$JS.API.STREAM.DELETE.${dmTarget}`, publisher.id) === "denied");
  check("TASK stream delete is refused", await request(profileCreds, `$JS.API.STREAM.DELETE.${taskTarget}`, publisher.id) === "denied");

  // The duplicate window must cover the publish timeout, so a publish retried inside the timeout is
  // deduplicated instead of stored twice. Checked on the live streams and on the canonical config.
  const admin = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }) });
  try {
    const jsm = await jetstreamManager(admin);
    for (const stream of [dmTarget, taskTarget]) {
      const liveMs = ((await jsm.streams.info(stream)).config.duplicate_window ?? 0) / 1_000_000;
      const canonicalMs = (canonicalBackupStreamConfig(space, stream).duplicate_window ?? 0) / 1_000_000;
      check(`${stream} duplicate_window covers the publish timeout`, liveMs >= PUBLISH_TIMEOUT_MS && canonicalMs >= PUBLISH_TIMEOUT_MS, { liveMs, canonicalMs, PUBLISH_TIMEOUT_MS });
    }
  } finally {
    await admin.drain().catch(() => {});
  }
} catch (error) {
  check("profile ACL scenarios completed", false, error instanceof Error ? error.message : String(error));
} finally {
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
