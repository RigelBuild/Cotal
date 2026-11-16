import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { assertScratchHeld, makeScratch, removeContained } from "../../../bin/smoke/_scratch.js";
import { DEV_OWNER, invokeCommand, mintCreds, mintLifecycleUid, newIdentity, resolveService, standaloneConnectOpts } from "@cotal-ai/core";
import { authDir, loadSpaceAuth, readManagerSeatMintCap, DEFAULT_SEAT_MINT_CAP } from "@cotal-ai/workspace";

const scratch = makeScratch("cotal-seat-mint-cap-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const defaultRoot = mkdtempSync(join(scratch, "default-"));
const config = join(home, "config");
const rootSandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const defaultSandbox = recordSmokeSandbox({ root: defaultRoot, cotalHome: home, xdgConfigHome: config });
let sandbox = rootSandbox;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", NO_COLOR: "1" });
const cli = resolve(import.meta.dirname, "../../../bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
let activeRoot = root;
async function run(args: string[]) {
  const options = { cwd: activeRoot, env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const child = spawn(process.execPath, ["--import", tsx, cli, ...args], options);
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await once(child, "exit");
  assert.equal(child.exitCode, 0, output);
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let manualManager: ReturnType<typeof spawn> | undefined;
let manualManagerOutput = "";
function startManualManager(args: string[]): void {
  const options = { cwd: activeRoot, env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const child = spawn(process.execPath, ["--import", tsx, cli, ...args], options);
  manualManager = child;
  manualManagerOutput = "";
  child.stdout.on("data", (chunk) => { manualManagerOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { manualManagerOutput += String(chunk); });
}
async function waitForManualManager(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!manualManagerOutput.includes("✓ manager up")) {
    if (manualManager?.exitCode !== null && manualManager?.exitCode !== undefined || manualManager?.signalCode !== null && manualManager?.signalCode !== undefined)
      throw new Error(`supervise exited before manager startup: ${manualManagerOutput}`);
    if (Date.now() >= deadline) throw new Error(`supervise did not report manager startup: ${manualManagerOutput}`);
    await sleep(50);
  }
}
async function stopManualManager(): Promise<void> {
  if (!manualManager || manualManager.exitCode !== null || manualManager.signalCode !== null) return;
  manualManager.kill("SIGTERM");
  await once(manualManager, "exit");
  manualManager = undefined;
}

async function reserveIdentity(space: string, name: string, creds: string, caller: { owner: string; actor: string; uid: string }) {
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const service = await resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
    return await invokeCommand(nc, space, service, "identity-reserve", { name }, {});
  } finally { await nc.close(); }
}

mkdirSync(join(root, ".cotal"), { recursive: true });
const server = `nats://127.0.0.1:${await freePort()}`;
try {
  await run(["space", "create", "captest", "--root", root]);
  assertScratchHeld(root);
  await run(["up", "--detach", "--space", "captest", "--server", server, "--seat-mint-cap", "2"]);
  await run(["service", "stop", "stack-manager", "--space", "captest", "--yes"]);
  startManualManager(["supervise", "--space", "captest", "--server", server, "--runtime", "pty", "--seat-mint-cap", "1"]);
  await waitForManualManager();
  assert.equal(readManagerSeatMintCap({ root, space: "captest" }), 1);
  const auth = loadSpaceAuth(authDir(root), "captest");
  assert.ok(auth);
  const identity = newIdentity();
  const caller = { owner: DEV_OWNER, actor: identity.id, uid: mintLifecycleUid() };
  const creds = await mintCreds(auth, identity, "agent", { principal: caller, lifecycleUid: caller.uid, endpointCapabilities: [{ endpoint: "manager", command: "identity-reserve" }] });
  assert.equal((await reserveIdentity("captest", "one", creds, caller)).reply.ok, true);
  await stopManualManager();
  await run(["up", "--detach", "--space", "captest"]);
  assert.equal(readManagerSeatMintCap({ root, space: "captest" }), 1);
  const afterRefresh = await reserveIdentity("captest", "two", creds, caller);
  assert.equal(afterRefresh.reply.error?.code, "resource-exhausted");
  console.log("PASS stack-up manager refresh keeps the supervise seat-mint cap");
  await run(["down", "--yes"]);
  activeRoot = defaultRoot;
  sandbox = defaultSandbox;
  await run(["space", "create", "defaultcap", "--root", defaultRoot]);
  await run(["up", "--detach", "--space", "defaultcap", "--server", server]);
  assert.equal(readManagerSeatMintCap({ root: defaultRoot, space: "defaultcap" }), undefined);
  const defaultAuth = loadSpaceAuth(authDir(defaultRoot), "defaultcap");
  assert.ok(defaultAuth);
  const defaultIdentity = newIdentity();
  const defaultCaller = { owner: DEV_OWNER, actor: defaultIdentity.id, uid: mintLifecycleUid() };
  const defaultCreds = await mintCreds(defaultAuth, defaultIdentity, "agent", { principal: defaultCaller, lifecycleUid: defaultCaller.uid, endpointCapabilities: [{ endpoint: "manager", command: "identity-reserve" }] });
  for (let index = 0; index < DEFAULT_SEAT_MINT_CAP; index++) {
    const reservation = await reserveIdentity("defaultcap", `default-${index}`, defaultCreds, defaultCaller);
    assert.equal(reservation.reply.ok, true, JSON.stringify(reservation.reply));
  }
  const overDefault = await reserveIdentity("defaultcap", "default-over", defaultCreds, defaultCaller);
  assert.equal(overDefault.reply.error?.code, "resource-exhausted");
  console.log(`PASS up without flag enforces cap ${DEFAULT_SEAT_MINT_CAP}`);
} finally {
  await stopManualManager();
  for (const [cleanupRoot, cleanupSandbox] of [[root, rootSandbox], [defaultRoot, defaultSandbox]] as const) {
    activeRoot = cleanupRoot;
    sandbox = cleanupSandbox;
    await run(["down", "--yes"]).catch(() => {});
  }
  assertScratchHeld(root);
  removeContained(scratch, dirname(scratch));
}

