/**
 * `cotal mint` capability forwarding, same-incarnation rotation, and manager spawn submission.
 * Run: pnpm smoke:mint-capabilities:manager
 */
import { strict as assert } from "node:assert";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, credsClaims, epRequestGrantRows,
  invokeCommand, mintCreds, newIdentity, resolveService,
  spawnCallerCapabilities, standaloneConnectOpts, setupSpaceStreams, registry,
  type Connector, type CotalMessage, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { runCli } from "@cotal-ai/cli";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

const home = mkdtempSync(join(tmpdir(), "cotal-mint-cap-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const stub = join(here, "e2e-stub.mjs");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const root = join(dir, "workspace");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const space = "mintcap";
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
saveSpaceAuth(authDir(root), auth);
recordMesh({ space, server: broker.servers, root, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
writeFileSync(join(root, ".cotal", "agents", "caller.md"), "---\nname: caller\ncapabilities: [spawn]\n---\n");
writeFileSync(join(root, ".cotal", "agents", "w1.md"), "---\nname: w1\nrole: worker\n---\n");

let passed = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  assert.ok(condition, `${name}${extra === undefined ? "" : `: ${JSON.stringify(extra)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};
class ExitSignal extends Error {}
async function runMint(argv: string[]): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const previous = [console.log, console.error, process.exit] as const;
  let code: number | undefined;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  process.exit = ((next?: number) => { code ??= next ?? 0; throw new ExitSignal(); }) as never;
  try {
    await runCli(registry, ["mint", ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    console.log = previous[0];
    console.error = previous[1];
    process.exit = previous[2];
  }
  return { out: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), code: code ?? 0 };
}
function facts(creds: string): { principal?: string; lifecycleUid: string; pubAllow: string[] } {
  const claims = credsClaims(creds);
  const rows = claims.nats?.pub?.allow ?? [];
  const tags = (claims.nats as NonNullable<typeof claims.nats> & { tags?: string[] }).tags ?? [];
  const principalTag = tags.find((value) => value.startsWith("principal:"));
  const uids = new Set<string>();
  for (const row of rows) {
    const match = /\.(?:dm|dlv|chathist)_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/.exec(row);
    if (match) uids.add(match[1]!);
  }
  if (uids.size !== 1) throw new Error(`credential carries ${uids.size} lifecycle UIDs; expected one`);
  return { principal: principalTag?.slice("principal:".length), lifecycleUid: [...uids][0]!, pubAllow: rows };
}
const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
const connections: NatsConnection[] = [];
let peer: CotalEndpoint | undefined;
let remintedEndpoint: CotalEndpoint | undefined;
let manager: Manager | undefined;
const cwd = process.cwd();

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  process.chdir(root);
  const callerPath = join(root, "caller.creds");
  const minted = await runMint(["caller", "--provision", "--out", callerPath]);
  check("mint --provision creates the capability credential", minted.code === 0, minted.out);
  const original = readFileSync(callerPath, "utf8");
  const originalFacts = facts(original);
  const principal = originalFacts.principal;
  const actor = principal?.split(".")[1];
  if (!principal || !actor) throw new Error("mint output credential has no principal tag");
  const caller: EpCaller = { owner: DEV_OWNER, actor, uid: originalFacts.lifecycleUid };
  const spawnRows = spawnCallerCapabilities(DEV_OWNER).flatMap((capability) => epRequestGrantRows(space, capability, caller));
  check("JWT contains every spawn caller permission row", spawnRows.every((row) => originalFacts.pubAllow.includes(row)), {
    missing: spawnRows.filter((row) => !originalFacts.pubAllow.includes(row)),
  });
  check("mint prints its capabilities", /capabilities:\s+spawn/.test(minted.out), minted.out);

  const peerRoot = join(dir, "peer");
  mkdirSync(join(peerRoot, ".cotal"), { recursive: true });
  saveSpaceAuth(authDir(peerRoot), auth);
  const peerCredsPath = join(peerRoot, "peer.creds");
  const peerMint = await runMint(["peer", "--provision", "--out", peerCredsPath]);
  check("peer is provisioned before the DM test", peerMint.code === 0, peerMint.out);
  const peerFacts = facts(readFileSync(peerCredsPath, "utf8"));
  peer = new CotalEndpoint({
    space, servers: broker.servers, creds: readFileSync(peerCredsPath, "utf8"), lifecycleUid: peerFacts.lifecycleUid,
    card: { name: "mint-peer", kind: "agent" }, channels: [], registerPresence: false, watchPresence: false,
  });
  await peer.start();
  await peer.unicast(principal, "message sent before credential rotation");

  const remintPath = join(root, "caller-reminted.creds");
  const sameIncarnation = await runMint(["caller", "--identity", callerPath, "--out", remintPath]);
  check("--identity re-mints the agent credential", sameIncarnation.code === 0, sameIncarnation.out);
  const remintedCreds = readFileSync(remintPath, "utf8");
  const remintedFacts = facts(remintedCreds);
  check("same-incarnation re-mint preserves the lifecycle UID", remintedFacts.lifecycleUid === originalFacts.lifecycleUid, { before: originalFacts.lifecycleUid, after: remintedFacts.lifecycleUid });
  check("same-incarnation re-mint preserves the principal", remintedFacts.principal === originalFacts.principal, { before: originalFacts.principal, after: remintedFacts.principal });

  const received: string[] = [];
  remintedEndpoint = new CotalEndpoint({
    space, servers: broker.servers, creds: remintedCreds, lifecycleUid: remintedFacts.lifecycleUid,
    card: { name: "caller", kind: "agent" }, channels: [], registerPresence: false, watchPresence: false,
  });
  remintedEndpoint.on("message", (message: CotalMessage) => received.push(message.parts.find((part) => part.kind === "text")?.text ?? ""));
  remintedEndpoint.on("error", () => {});
  await remintedEndpoint.start();
  for (let attempt = 0; attempt < 80 && received.length === 0; attempt++) await wait(50);
  check("same-incarnation re-mint receives the DM sent before rotation", received.includes("message sent before credential rotation"), received);

  const newIncarnationPath = join(root, "caller-new-incarnation.creds");
  const newIncarnation = await runMint(["caller", "--identity", callerPath, "--new-incarnation", "--provision", "--out", newIncarnationPath]);
  check("--new-incarnation re-mint succeeds", newIncarnation.code === 0, newIncarnation.out);
  const newFacts = facts(readFileSync(newIncarnationPath, "utf8"));
  check("--new-incarnation preserves the nkey", newFacts.principal === originalFacts.principal, { before: originalFacts.principal, after: newFacts.principal });
  check("--new-incarnation creates a fresh lifecycle UID", newFacts.lifecycleUid !== originalFacts.lifecycleUid, { before: originalFacts.lifecycleUid, after: newFacts.lifecycleUid });

  const freshPath = join(root, "caller-fresh.creds");
  const fresh = await runMint(["fresh", "--new-incarnation", "--out", freshPath]);
  check("--new-incarnation without --identity leaves a fresh mint usable", fresh.code === 0 && facts(readFileSync(freshPath, "utf8")).lifecycleUid.length >= 26, fresh.out);

  const envFor = (options: LaunchOpts): Record<string, string> => ({
    COTAL_SPACE: options.space,
    COTAL_SERVERS: String(options.servers ?? broker.servers),
    COTAL_CREDS: String(options.creds),
    COTAL_ID: String(options.id),
    COTAL_NAME: options.name,
    PATH: process.env.PATH ?? "",
    ...(options.lifecycleUid ? { COTAL_LIFECYCLE_UID: options.lifecycleUid } : {}),
  });
  registry.register({
    kind: "connector", name: "e2e-stub", requires: ["node"], readinessTimeoutMs: 20_000,
    buildLaunch: (options): LaunchSpec => ({ command: "node", args: [stub], env: envFor(options) }),
  } as Connector);
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: original, tls: false }), maxReconnectAttempts: 0 });
  connections.push(nc);
  const service = await resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
  const spawnReply = await invokeCommand(nc, space, service, "spawn", { name: "w1", agent: "e2e-stub", cwd: repoRoot, events: false }, { deadlineMs: 30_000 });
  const accepted = spawnReply.reply.data as { name?: string } | undefined;
  check("minted spawn capability submits a manager spawn", spawnReply.reply.ok === true && accepted?.name === "w1", spawnReply.reply);
} finally {
  await remintedEndpoint?.stop().catch(() => {});
  await peer?.stop().catch(() => {});
  await manager?.stop({ withAgents: true }).catch(() => {});
  for (const connection of connections) await connection.close().catch(() => {});
  process.chdir(cwd);
  await broker.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nMINT CAPABILITIES SMOKE OK  (${passed} passed)`);
