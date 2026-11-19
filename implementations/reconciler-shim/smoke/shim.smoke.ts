/** Run after building core and this package: pnpm --filter @cotal-ai/reconciler-shim test (needs nats-server).
 *  The shim on a real broker: the seat commands are served on a registered endpoint, each call is
 *  forwarded over a Unix socket to a stand-in reconciler, and the reply maps back to the caller. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, DEV_OWNER, EpEnvelopeError, createSpaceAuth, dialerFor, epCall, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig,
  setupSpaceStreams, standaloneConnectOpts, type EpErrorCode,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  SEATS_ENDPOINT, SEAT_CONTRACTS, runReconcilerShim, seatCallerCapabilities, seatClusterDocument, seatContractArtifactValues,
  type ReconcilerShimHandle, type SeatsServeBundle,
} from "../src/index.js";
import { registerFixture, type FixtureMesh } from "../../registry/smoke/_fixture.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { startFakeReconciler, type FakeBehaviour } from "./_fake-reconciler.js";

type Outcome = { value: unknown } | { error: unknown };
const codeOf = (o: Outcome): string | undefined => ("error" in o && o.error instanceof EpEnvelopeError ? o.error.code : undefined);

const OP_ID = "11111111-1111-4111-8111-111111111111";
const HANDOFF_OP_ID = "22222222-2222-4222-8222-222222222222";
const op = { operationId: OP_ID, name: "alpha", expectedSeatRevision: 6 };
const handoffRequest = { restartOperationId: HANDOFF_OP_ID, name: "alpha", predecessorGeneration: 3, restartGeneration: 4 };

// Valid bodies for the three execution commands: the closed shapes in launch-protocol.md § Agent management.
const ACCEPT_ID = "66666666-6666-4666-8666-666666666666";
const ENROLL_ID = "77777777-7777-4777-8777-777777777777";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const claimOf = (uid: string) => ({ accountPublicKey: `A${"B".repeat(55)}`, instanceId: uid, managerLifecycleUid: uid, assignmentRevision: 1, currentRegistrationRevision: 1, serveEpoch: 1 });
const lifecycleOf = (uid: string) => ({ space: "seats", owner: "local", actor: "operator", lifecycleUid: uid });
const authorityOf = (uid: string) => ({
  subject: { acceptanceId: ACCEPT_ID, enrollmentOperationId: ENROLL_ID, phase: "accepted" },
  placementOperationId: OP_ID, intentDigest: DIGEST, claim: claimOf(uid), launchRevision: 1,
});
const executionBodies = (uid: string) => ({
  acceptIntent: {
    operationId: OP_ID, claim: claimOf(uid),
    intent: {
      placement: { space: "main", name: "alpha", desiredRevision: 6, seatRevision: 6, claim: claimOf(uid), generation: 1, operationId: OP_ID, workspace: "ws-alpha" },
      cwd: "/work/alpha", workspaceDigest: DIGEST, persona: "reviewer", personaDigest: DIGEST,
      profile: { name: "default", revision: "r1", configRevision: "c1", modelRoles: { main: "model-a" }, sha256: DIGEST },
      role: "worker", roleTreeRevision: 3,
      assets: {
        revision: "a1", digest: DIGEST, imageDigest: "img-1", baselineConfigDigest: DIGEST, modelCatalogDigest: DIGEST, personaCatalogDigest: DIGEST,
        extensionsDigest: DIGEST, rulesSkillsDigest: DIGEST, cliClosureDigest: DIGEST, toolBindings: [{ id: "t1", endpoint: "tools", entitlementRef: "e1" }],
      },
      key: { routing: { claude: "shared" }, limits: { keyCap: { usd: 5, window: { kind: "rolling", seconds: 3600 } } }, policyId: "policy-1" },
      policyRevision: 2, restartGeneration: 0, digest: DIGEST,
    },
  },
  acceptedIntent: { acceptanceId: ACCEPT_ID, authority: authorityOf(uid), actorTokenHash: "cd".repeat(32) },
  bindEnrollment: {
    operationId: OP_ID, authority: authorityOf(uid),
    identity: { acceptanceId: ACCEPT_ID, enrollmentOperationId: ENROLL_ID, enrollmentRef: "enroll-ref-1", target: { seatName: "alpha", lifecycle: lifecycleOf(uid), generation: 1 }, intentDigest: DIGEST },
  },
});

const suite = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const fake = await startFakeReconciler(dir);
const port = await pickFreePort();
const space = "seats";
const servers = `nats://127.0.0.1:${port}`;
const storeDir = join(dir, "nats");
mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
const mesh: FixtureMesh = { auth, servers, space };
writeFileSync(join(dir, "broker.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const log = openSync(join(dir, "broker.log"), "w");
const broker = spawn("nats-server", ["-c", join(dir, "broker.conf")], { stdio: ["ignore", log, log] });
const releaseBroker = teardownOnSignal(broker, dir);
let shim: ReconcilerShimHandle | undefined;
let caller: CotalEndpoint | undefined;

try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  for (let i = 0; i < 50 && broker.exitCode === null && !(await isReachable(servers, { creds: provisioner })); i++) await new Promise((r) => setTimeout(r, 200));
  if (broker.exitCode !== null) throw new Error(`broker exited: ${readFileSync(join(dir, "broker.log"), "utf8")}`);
  await setupSpaceStreams({ servers, space, creds: provisioner });

  const { grant, creds } = await registerFixture(mesh, SEATS_ENDPOINT, seatClusterDocument(), { extra: seatContractArtifactValues() });
  const bundle: SeatsServeBundle = { servers, space, tls: false, grant, creds: () => creds };
  let shimError: string | undefined;
  try {
    shim = await runReconcilerShim(bundle, { socketPath: fake.socketPath, socketDeadlineMs: 400 });
  } catch (e) {
    shimError = e instanceof Error ? e.message : String(e);
  }

  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const callerCreds = await mintCreds(auth, identity, "agent", { lifecycleUid, endpointCapabilities: seatCallerCapabilities(SEATS_ENDPOINT) });
  const ep = new CotalEndpoint({
    space, servers, creds: callerCreds, lifecycleUid,
    card: { id: identity.id, name: "operator", kind: "agent" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  caller = ep;
  ep.on("error", () => {});
  await ep.start();

  // A responder refusal comes back as an ok:false reply; raise it as the caller-side error.
  const invoke = (command: string, body: Record<string, unknown>): Promise<Outcome> =>
    ep.invokeService(SEATS_ENDPOINT, command, body).then(
      ({ reply }): Outcome => (reply.ok ? { value: reply.data } : { error: new EpEnvelopeError(reply.error.code as EpErrorCode, reply.error.message) }),
      (error: unknown): Outcome => ({ error }),
    );
  const withBehaviour = async (next: FakeBehaviour, command: string, body: Record<string, unknown>): Promise<Outcome> => {
    fake.setBehaviour(next);
    const outcome = await invoke(command, body);
    fake.setBehaviour("ok");
    return outcome;
  };

  const forwarded = await invoke("pause", op);
  const last = fake.received.at(-1);
  suite.check("a pause is forwarded with its subject, and the top-level command is wave-seats.pause",
    "value" in forwarded && JSON.stringify(forwarded.value).includes("wave-seats.pause")
      && last?.command === "wave-seats.pause" && last.subject.endpoint === SEATS_ENDPOINT && last.subject.command === "pause"
      && JSON.stringify(last.args) === JSON.stringify(op),
    { forwarded, last, shimError });
  suite.check("the subject reaches the reconciler unchanged: the caller triple, route one, no target, a nonce",
    last?.subject.caller.owner === DEV_OWNER && last.subject.caller.actor === identity.id && last.subject.caller.uid === lifecycleUid
      && last.subject.route === "one" && last.subject.target === null && last.subject.nonce.length > 0,
    { subject: last?.subject, shimError });

  const refused = await withBehaviour("refuse", "pause", op);
  suite.check("a refusal from the reconciler reaches the caller with its error code unchanged",
    codeOf(refused) === "permission-denied" && "error" in refused && refused.error instanceof EpEnvelopeError && refused.error.message === "seat not yours",
    { refused, shimError });

  await fake.down();
  const unreachable = await invoke("pause", op);
  await fake.up();
  suite.check("an unreachable reconciler socket raises unavailable", codeOf(unreachable) === "unavailable", { unreachable, shimError });

  const malformed = await withBehaviour("malformed", "pause", op);
  suite.check("a malformed reconciler reply raises unavailable", codeOf(malformed) === "unavailable", { malformed, shimError });

  const nonObject = await withBehaviour("non-object-result", "pause", op);
  suite.check("a success reply whose result is not an object raises unavailable", codeOf(nonObject) === "unavailable", { nonObject, shimError });

  const unknownCode = await withBehaviour("unknown-code", "pause", op);
  suite.check("a reconciler error code outside the Cotal catalog raises unavailable", codeOf(unknownCode) === "unavailable", { unknownCode, shimError });

  const oversized = await withBehaviour("oversized", "pause", op);
  suite.check("an oversized (over 1 MiB) reconciler reply raises unavailable", codeOf(oversized) === "unavailable", { oversized: codeOf(oversized), shimError });

  const silent = await withBehaviour("silent", "pause", op);
  suite.check("a reconciler reply past the socket deadline raises unavailable", codeOf(silent) === "unavailable", { silent, shimError });

  // The caller validates too, so publish with a caller-side validator that admits anything: this
  // proves the shim's own schema check refuses before the socket.
  const rawNc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds: callerCreds, tls: false }) });
  const unchecked = (command: string, args: Record<string, unknown>): Promise<Outcome> => {
    const real = SEAT_CONTRACTS[command]!;
    // SAFETY: smoke-only; the stub validator replaces the caller's check so the body reaches the shim.
    const admitAll = Object.assign(() => true, { errors: null }) as unknown as typeof real.input.validate;
    return epCall(rawNc, space, { mode: "one" }, {
      endpoint: SEATS_ENDPOINT, command, args, caller: { owner: DEV_OWNER, actor: identity.id, uid: lifecycleUid },
      contract: { input: { validate: admitAll, closureDigest: real.input.closureDigest }, output: real.output },
    }, { deadlineMs: 5_000, currentEpoch: () => grant.epoch }).then(
      ({ reply }): Outcome => (reply.ok ? { value: reply.data } : { error: new EpEnvelopeError(reply.error.code as EpErrorCode, reply.error.message) }),
      (error: unknown): Outcome => ({ error }),
    );
  };
  const before = fake.received.length;
  const extraKey = await unchecked("pause", { ...op, bogus: true });
  const badBase64 = await unchecked("handoff-upload", { request: handoffRequest, content: "not base64!" });
  const unpadded = await unchecked("handoff-upload", { request: handoffRequest, content: "AB=" });
  const overCap = await unchecked("handoff-upload", { request: handoffRequest, content: Buffer.alloc(256 * 1024 + 1).toString("base64") });
  await rawNc.close();
  suite.check("the shim refuses a schema-invalid body or over-cap content as bad-request, and none reaches the socket",
    [extraKey, badBase64, unpadded, overCap].every((o) => codeOf(o) === "bad-request") && fake.received.length === before,
    { codes: [extraKey, badBase64, unpadded, overCap].map(codeOf), received: fake.received.length - before, shimError });

  const atCap = await invoke("handoff-upload", { request: handoffRequest, content: Buffer.alloc(256 * 1024).toString("base64") });
  suite.check("handoff content of exactly 256 KiB decoded is forwarded", "value" in atCap, { atCap: codeOf(atCap), shimError });

  const keyArgs = (window: Record<string, unknown>) => ({
    ...op, key: { routing: { claude: "shared" }, limits: { keyCap: { usd: 5, window } } },
  });
  const fixed = await invoke("set-key", keyArgs({ kind: "fixed", seconds: 3600, anchorUtc: "2026-01-01T00:00:00Z", timezone: "UTC" }));
  const rolling = await invoke("set-key", keyArgs({ kind: "rolling", seconds: 3600 }));
  suite.check("set-key admits both a fixed and a rolling cap window", "value" in fixed && "value" in rolling,
    { fixed: codeOf(fixed), rolling: codeOf(rolling), shimError });

  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const content = bytes.toString("base64");
  const upload = await invoke("handoff-upload", { request: handoffRequest, content });
  const sent = fake.received.at(-1);
  suite.check("handoff-upload content reaches the reconciler as the base64 of its bytes",
    "value" in upload && sent?.command === "wave-seats.handoff-upload" && sent.args.content === content
      && Buffer.from(String(sent.args.content), "base64").equals(bytes),
    { upload, sent, shimError });

  // The three execution commands are served: each is forwarded under its own command name. A token
  // the catalogue does not list is refused before it reaches the socket.
  const bodies = executionBodies(lifecycleUid);
  for (const [command, body] of [["accept-intent", bodies.acceptIntent], ["accepted-intent", bodies.acceptedIntent], ["bind-enrollment", bodies.bindEnrollment]] as const) {
    const outcome = await invoke(command, body);
    const sent = fake.received.at(-1);
    suite.check(`${command} is served and forwarded as wave-seats.${command}`,
      "value" in outcome && sent?.command === `wave-seats.${command}` && sent.subject.command === command && JSON.stringify(sent.args) === JSON.stringify(body),
      { command, outcome: codeOf(outcome), shimError });
  }
  const beforeUnlisted = fake.received.length;
  const unlisted = await invoke("enroll-placement", {});
  suite.check("a token outside the seat catalogue is refused as not-found and never reaches the socket",
    codeOf(unlisted) === "not-found" && fake.received.length === beforeUnlisted,
    { unlisted: codeOf(unlisted), shimError });

  for (let i = 0; i < 20 && fake.openSockets() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  suite.check("every reconciler connection is closed after its call", fake.received.length > 0 && fake.openSockets() === 0,
    { open: fake.openSockets(), received: fake.received.length, shimError });
} finally {
  await caller?.stop().catch(() => {});
  await shim?.stop().catch(() => {});
  await fake.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
