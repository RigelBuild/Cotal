import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { makeScratch } from "../../../bin/smoke/_scratch.js";
import { DEV_OWNER, invokeCommand, mintCreds, mintLifecycleUid, newIdentity, resolveService, standaloneConnectOpts } from "@cotal-ai/core";
import { authDir, loadSpaceAuth, readManagerSeatMintCap, DEFAULT_SEAT_MINT_CAP } from "@cotal-ai/workspace";

const scratch = makeScratch("cotal-seat-mint-cap-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const defaultRoot = mkdtempSync(join(scratch, "default-"));
const config = join(home, "config");
let sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
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

mkdirSync(join(root, ".cotal"), { recursive: true });
const server = `nats://127.0.0.1:${await freePort()}`;
try {
  await run(["up", "--detach", "--space", "captest", "--server", server, "--seat-mint-cap", "2"]);
  assert.equal(readManagerSeatMintCap({ root, space: "captest" }), 2);
  const auth = loadSpaceAuth(authDir(root), "captest");
  assert.ok(auth);
  const identity = newIdentity();
  const caller = { owner: DEV_OWNER, actor: identity.id, uid: mintLifecycleUid() };
  const creds = await mintCreds(auth, identity, "agent", { principal: caller, lifecycleUid: caller.uid, endpointCapabilities: [{ endpoint: "manager", command: "identity-reserve" }] });
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const service = await resolveService(nc, "captest", "manager", caller, { deadlineMs: 10_000 });
    const opts = { currentEpoch: async () => 0 };
    for (const name of ["one", "two"]) assert.equal((await invokeCommand(nc, "captest", service, "identity-reserve", { name }, opts)).reply.ok, true);
    const third = await invokeCommand(nc, "captest", service, "identity-reserve", { name: "three" }, opts);
    assert.equal(third.reply.error?.code, "resource-exhausted");
    console.log("PASS up cap 2 refuses third reserve");
  } finally { await nc.close(); }
  await run(["down", "--yes"]);
  activeRoot = defaultRoot;
  sandbox = recordSmokeSandbox({ root: defaultRoot, cotalHome: home, xdgConfigHome: config });
  mkdirSync(join(defaultRoot, ".cotal"), { recursive: true });
  await run(["up", "--detach", "--space", "defaultcap", "--server", server]);
  assert.equal(readManagerSeatMintCap({ root: defaultRoot, space: "defaultcap" }) ?? DEFAULT_SEAT_MINT_CAP, 32);
  console.log("PASS up without flag resolves cap 32");
} finally {
  await run(["down", "--yes"]);
}
assert.equal(DEFAULT_SEAT_MINT_CAP, 32);
