/**
 * `cotal spawn --creds <file> --lifecycle-uid <uid>` in the foreground: a seedless launch.
 *
 * The launch runs from a directory with no `.cotal` at all, against a mesh whose record names a
 * root with no trust material, so nothing on this host can mint or provision. The credential is
 * minted and provisioned out of band (as `cotal mint --provision` would), then handed to the spawn.
 * Cells:
 *   - refusals: no uid, a malformed uid, a uid the credential does not name, `--lifecycle-uid`
 *     outside a foreground creds launch, and a credential without its event-channel grant;
 *   - `--creds --detach` still takes the detached control path (unchanged semantics);
 *   - the valid launch reaches presence as the credential's identity under the persona's name;
 *   - the material file carries the creds path and servers, the child environment carries neither;
 *   - the credential's own grants set COTAL_CAPABILITIES, and the operator's file survives exit.
 *
 * The connector env is the real Hermes `buildLaunch`; only its command is replaced by a node child
 * that joins the mesh from the material file alone.
 *
 * Run: pnpm smoke:spawn-creds
 */
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Connector, LaunchOpts, LaunchSpec, Presence } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const temp = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}spawn-creds-`));
const home = join(temp, "home");
const launchDir = join(temp, "launch");
mkdirSync(home, { recursive: true });
mkdirSync(launchDir, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
process.env.COTAL_NO_PROMPT = "1";
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

// Dynamic on purpose: COTAL_HOME and friends must be set before these modules read them at load.
await import("../src/index.js");
const { runCli } = await import("../src/command.js");
const { CotalEndpoint, createSpaceAuth, eventChannel, mintCreds, mintLifecycleUid, newIdentity, principalKey, probeConnect, provisionAgent, registry, serverConfig, setupSpaceStreams, DEV_OWNER, LAUNCH_MATERIAL_ENV } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { hermesConnector } = await import("../../../extensions/connector-hermes/src/extension.js");

/** What the child wrote: its pid, its whole env, the material it read, and how its join went. */
interface ChildReport { pid: number; env: Record<string, string>; material: Record<string, unknown>; started?: boolean; error?: string }

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 400)); }
};
const report = join(temp, "child.json");
const coreDist = resolve(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");
// The child holds only what the launch handed it: env from Hermes' buildLaunch plus the material file.
const CHILD = [
  "const fs=require('node:fs');const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint,readLaunchMaterial})=>{",
  "const m=readLaunchMaterial(process.env.COTAL_LAUNCH_MATERIAL);",
  "const out={pid:process.pid,env:process.env,material:m};const save=()=>fs.writeFileSync(process.env.REPORT,JSON.stringify(out));save();",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:m.servers,creds:fs.readFileSync(m.creds,'utf8'),lifecycleUid:process.env.COTAL_LIFECYCLE_UID,channels:[],card:{id:process.env.COTAL_ID,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',(e)=>{out.error=String(e.message);save();});",
  "try{await ep.start();out.started=true;}catch(e){out.error=String(e&&e.message);}save();setInterval(()=>{},1000);});",
].join("");
let lastSpec: LaunchSpec | undefined;
const probe: Connector = {
  kind: "connector",
  name: "creds-probe",
  requires: [],
  eventChannel,
  buildLaunch: (o: LaunchOpts): LaunchSpec => {
    const real = hermesConnector.buildLaunch(o);
    lastSpec = { command: process.execPath, args: ["-e", CHILD], env: { ...real.env, CORE_DIST: coreDist, REPORT: report } };
    return lastSpec;
  },
};
registry.register(probe);

/** Real argv through the binary's dispatch; a refusal's process.exit becomes an observable code. */
async function run(argv: string[]): Promise<{ exited?: number; stderr: string }> {
  const realExit = process.exit;
  const realErr = console.error;
  const realWrite = process.stderr.write.bind(process.stderr);
  let exited: number | undefined;
  let stderr = "";
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(" ") + "\n"; };
  // A refusal ends the process; turning it into a throw makes "it refused" observable (as the sibling suites do).
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exited = code ?? 0;
    throw new Error(`__exit__${exited}`);
  }) as never;
  try {
    await runCli(registry, argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) stderr += `threw: ${msg}\n`;
  } finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    console.error = realErr;
    process.stderr.write = realWrite;
  }
  return { exited, stderr };
}

const SPACE = "spawncreds";
const auth = await createSpaceAuth(SPACE);
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
writeFileSync(join(temp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(temp, "js") }));
const broker = spawnProcess("nats-server", ["-c", join(temp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, temp);
let observer: InstanceType<typeof CotalEndpoint> | undefined;
let childPid: number | undefined;
const cwd = process.cwd();
try {
  await awaitBrokerReady(async () => (await probeConnect(server, { creds: await mintCreds(auth, newIdentity(), "probe") })).ok, { servers: server, attempts: 100, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // Out of band: the operator mints and provisions the agent where the seed lives.
  const provisioner = new CotalEndpoint({ space: SPACE, servers: server, creds: await mintCreds(auth, newIdentity(), "provisioner"), card: { name: "provisioner", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  await provisioner.start();
  const actor = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const creds = await provisionAgent(provisioner, auth, actor, {
    lifecycleUid, subscribe: [], allowSubscribe: [], capabilities: ["spawn"],
    allowPublish: [eventChannel({ owner: DEV_OWNER, actor: actor.id })],
  });
  const bare = newIdentity();
  const bareUid = mintLifecycleUid();
  const bareCreds = await provisionAgent(provisioner, auth, bare, { lifecycleUid: bareUid, subscribe: [], allowSubscribe: [] });
  await provisioner.stop();
  const credsPath = join(temp, "agent.creds");
  const bareCredsPath = join(temp, "bare.creds");
  writeFileSync(credsPath, creds, { mode: 0o600 });
  writeFileSync(bareCredsPath, bareCreds, { mode: 0o600 });

  // The launch host: a mesh record whose root holds nothing, and a persona outside any catalog.
  recordMesh({ space: SPACE, server, root: launchDir, mode: "auth", origin: "manual", ts: new Date().toISOString() });
  const persona = join(temp, "seedless.md");
  writeFileSync(persona, "---\nname: seedless\nrole: worker\nsubscribe: []\nallowSubscribe: []\n---\nseedless spawn acceptance\n");
  process.chdir(launchDir);
  const base = ["spawn", "--config", persona, "--space", SPACE, "--agent", "creds-probe"];

  console.log("refusals");
  {
    const r = await run([...base, "--creds", credsPath]);
    check("no uid: exits 1 with the pairing refusal", r.exited === 1 && /lifecycle-paired/.test(r.stderr), r);
  }
  {
    const r = await run([...base, "--creds", credsPath, "--lifecycle-uid", "NOT!A!UID"]);
    check("malformed uid: exits 1 on the token grammar", r.exited === 1 && /lifecycle/i.test(r.stderr) && !/lifecycle-paired/.test(r.stderr), r);
  }
  {
    const wrong = mintLifecycleUid();
    const r = await run([...base, "--creds", credsPath, "--lifecycle-uid", wrong]);
    check("wrong uid: exits 1 naming the uid and its dm_ durable", r.exited === 1 && r.stderr.includes(wrong) && /dm_/.test(r.stderr), r);
    check("wrong uid: refused before any launch", lastSpec === undefined, lastSpec);
  }
  {
    const r = await run([...base, "--lifecycle-uid", lifecycleUid]);
    check("--lifecycle-uid without --creds is refused", r.exited === 1 && /applies only to a foreground/.test(r.stderr), r);
  }
  {
    const r = await run([...base, "--creds", credsPath, "--lifecycle-uid", lifecycleUid, "--detach"]);
    check("--lifecycle-uid with --detach is refused", r.exited === 1 && /applies only to a foreground/.test(r.stderr), r);
  }
  {
    const r = await run([...base, "--creds", credsPath, "--detach", "--server", "nats://127.0.0.1:1"]);
    check("--creds --detach keeps the control path (no pairing refusal, fails at the unreachable broker)",
      r.exited === 1 && !/lifecycle-paired/.test(r.stderr) && /127\.0\.0\.1:1/.test(r.stderr), r);
  }
  {
    const r = await run([...base, "--creds", bareCredsPath, "--lifecycle-uid", bareUid]);
    check("a credential without its event-channel grant is refused unless --no-events", r.exited === 1 && /event channel/.test(r.stderr), r);
    check("event-grant refusal happens before any launch", lastSpec === undefined, lastSpec);
  }

  console.log("seedless foreground launch");
  observer = new CotalEndpoint({ space: SPACE, servers: server, creds: await mintCreds(auth, newIdentity(), "observer"), card: { name: "observer", kind: "endpoint" }, channels: [], consume: false, registerPresence: false });
  await observer.start();
  const launched = run([...base, "--creds", credsPath, "--lifecycle-uid", lifecycleUid]);
  let presence: Presence | undefined;
  // Presence is keyed by principal: the dev owner qualifies the credential's actor id.
  const presenceId = principalKey(DEV_OWNER, actor.id).key;
  for (let i = 0; i < 150 && !presence; i++) {
    await sleep(100);
    presence = observer.getRoster().find((p) => p.card.id === presenceId && p.status !== "offline");
  }
  check("the pre-minted identity reaches presence", presence !== undefined, observer.getRoster().map((p) => p.card.id));
  check("under the persona's name", presence?.card.name === "seedless", presence?.card);
  // SAFETY: the child above writes exactly this shape; it is this suite's own fixture.
  const child: ChildReport | undefined = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as ChildReport) : undefined;
  childPid = child?.pid;
  check("the child's endpoint joined without error", child?.started === true && child.error === undefined, child?.error);
  check("the material file carries the creds path", child?.material.creds === resolve(credsPath), child?.material);
  check("the material file carries the servers", child?.material.servers === server, child?.material);
  const envValues = Object.values(child?.env ?? {});
  check("the child env names the material file", typeof child?.env[LAUNCH_MATERIAL_ENV] === "string");
  check("the child env carries no creds path", child !== undefined && !envValues.some((v) => v.includes(credsPath)), child?.env);
  check("the child env carries no server URL", child !== undefined && !envValues.some((v) => v.includes(server)));
  check("the child env carries no COTAL_CREDS / COTAL_SERVERS", child !== undefined && !("COTAL_CREDS" in child.env) && !("COTAL_SERVERS" in child.env));
  check("COTAL_CAPABILITIES comes from the credential's grants", child?.env.COTAL_CAPABILITIES === "spawn", child?.env.COTAL_CAPABILITIES);
  check("COTAL_ID / COTAL_LIFECYCLE_UID are the credential's", child?.env.COTAL_ID === actor.id && child?.env.COTAL_LIFECYCLE_UID === lifecycleUid);
  if (childPid) process.kill(childPid, "SIGTERM");
  const done = await launched;
  childPid = undefined;
  check("the spawn returns once the child exits", done.exited === undefined, done);
  check("the launch root still has no .cotal", !existsSync(join(launchDir, ".cotal")));
  check("the operator's credential file is not retired", existsSync(credsPath));
  check("no secret material was written", !/retired creds|wrote creds/.test(done.stderr), done.stderr);
} finally {
  process.chdir(cwd);
  process.exitCode = fail === 0 ? 0 : 1;
  if (childPid) try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
  await observer?.stop().catch(() => {});
  releaseBroker();
  if (broker.exitCode === null) broker.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}

const EXPECTED = 24;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
console.log(`\nSPAWN-CREDS ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
