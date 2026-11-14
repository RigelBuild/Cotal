/** A remote user mesh whose manager runs on this machine is read for custody before an update, not
 * skipped as a manager that runs elsewhere. The skip stays for a remote mesh no supervisor here may
 * serve. The exchange address refuses every connection, so the read ends in a refusal, never in a
 * verdict this machine did not observe.
 * Run: pnpm smoke:update-remote-custody
 */
import rawAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(rawAssert);
const assert: typeof rawAssert = counted.assert;
const cells = counted.cells;
const root = mkdtempSync(join(tmpdir(), "cotal-update-remote-custody-"));
const home = join(root, "home"), config = join(root, "config"), project = join(root, "project");
for (const path of [home, config, project, join(project, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
process.env.COTAL_HOME = join(home, ".cotal");
process.env.XDG_CONFIG_HOME = config;
process.env.DO_NOT_TRACK = "1";
// These imports follow the isolated home setup because workspace paths are captured at module load.
const { recordMesh, setCurrent, userAuthStateDir } = await import("@cotal-ai/workspace");
const { readManagerContinuity } = await import("../src/commands/update.js");
// Loading @cotal-ai/auth registers the "cotal" provider the remote read needs.
await import("@cotal-ai/auth");
const { saveIdpSession } = await import("../../auth/src/login.js");
const { supervisorMayServe } = await import("../src/lib/manager-proc.js");

const space = `update-remote-${process.pid}`;
// Hold both addresses for the whole run so no foreign listener answers a probe; neither accepts.
const broker = createTcpServer((socket) => socket.destroy());
let exchangeRequests = 0;
const exchange = createTcpServer((socket) => { exchangeRequests++; socket.destroy(); });
const idpServer = createHttpServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ token: "e30.eyJzdWIiOiJmaXh0dXJlLWh1bWFuIn0.fixture" }));
});
let decoy: ChildProcess | undefined;
let other: ChildProcess | undefined;
try {
  await new Promise<void>((resolve) => idpServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => exchange.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(exchange.address() as { port: number }).port}`;
  const idp = `http://127.0.0.1:${(idpServer.address() as { port: number }).port}/api/auth`;
  const state = userAuthStateDir(project, space);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sentinel = join(state, "sentinel.creds");
  writeFileSync(sentinel, "synthetic-sentinel-not-used", { mode: 0o600 });
  recordMesh({
    space, server: `nats://127.0.0.1:${(broker.address() as { port: number }).port}`, root: project, mode: "user", origin: "manual",
    ts: new Date().toISOString(),
    userAuth: { provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: base }, sentinelCredsPath: sentinel },
  });
  setCurrent(space);
  saveIdpSession(join(home, ".cotal"), idp, { token: "isolated-fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "fixture-human" });

  // `--on` is read before any mesh is dialed, with the grammar every other manager command uses: an
  // empty value and a roster principal id are refused naming the instance id the flag wants, so a
  // pin typed for the manager whose custody this install carries is never silently dropped.
  for (const [on, why] of [["", "an empty pin"], ["local.U0123456789abcdefghijklmnop", "a principal id"]] as const) {
    await assert.rejects(readManagerContinuity({ space, on }), (e: unknown) => (e as { code?: string }).code === "USAGE_INVALID" && String((e as Error).message).includes("--on"), `${why} is refused as a manager pin before the continuity read`);
  }

  const baseline = supervisorMayServe(space);
  if (baseline) {
    console.log("note: a supervisor on this machine may already serve any space; the skip is not asserted here");
  } else {
    assert.equal(await readManagerContinuity({ space }), "none", "a remote mesh no supervisor here may serve is skipped");
  }

  // A service unit's supervisor passes no `--space`; its environment names the space it serves.
  other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise"],
    { stdio: "ignore", env: { ...process.env, COTAL_SPACE: `${space}-other` } });
  await once(other, "spawn");
  assert.equal(supervisorMayServe(space), baseline, "a space-less supervisor whose environment names another space is not a manager of this one");
  assert.equal(supervisorMayServe(`${space}-other`), true, "it is seen as a supervisor of the space its environment names");
  other.kill("SIGKILL");
  other = undefined;

  // A process whose command line is a supervisor for this space, as `ps` reports it.
  decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise", "--space", space], { stdio: "ignore" });
  await once(decoy, "spawn");
  assert.equal(supervisorMayServe(space), true, "the decoy is seen as a supervisor that may serve the space");
  let outcome: string;
  try {
    outcome = await readManagerContinuity({ space });
  } catch (e) {
    outcome = `refused: ${e instanceof Error ? e.message : String(e)}`;
  }
  assert.notEqual(outcome, "none", "a remote mesh served from this machine is read, not reported as running elsewhere");
  assert.ok(outcome.startsWith("refused: "), `an exchange that answers nothing ends the read in a refusal: ${outcome}`);
  assert.match(outcome, /did not answer at http:\/\/127\.0\.0\.1:/, `the registered auth provider must reach the refused fixture exchange, not fail provider lookup or login: ${outcome}`);
  assert.ok(exchangeRequests > 0, "the registered provider reaches the refusing fixture exchange");
  decoy.kill("SIGKILL");
  await once(decoy, "exit");
  decoy = undefined;

  // #5902: a supervisor that loaded ANOTHER install's CLI entry is no custody of this install, however
  // it was started; one that loaded this process's entry is read whatever node binary or loader ran
  // it; one whose entry cannot be told apart still counts.
  const idle = "setInterval(() => {}, 1 << 30)";
  const thisEntry = process.argv[1]!;
  const otherInstall = join(root, "other-install", "lib", "node_modules", "cotal-ai");
  mkdirSync(join(otherInstall, "dist"), { recursive: true });
  writeFileSync(join(otherInstall, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }));
  const otherEntry = join(otherInstall, "dist", "cotal.js");
  writeFileSync(otherEntry, `${idle};\n`);
  mkdirSync(join(root, "other-install", "bin"), { recursive: true });
  const otherShim = join(root, "other-install", "bin", "cotal");
  symlinkSync(otherEntry, otherShim);
  const otherNode = join(root, "othernode");
  symlinkSync(process.execPath, otherNode);
  const loader = join(root, "loader.mjs");
  writeFileSync(loader, "export {};\n");
  const cases: [string, string, string[], boolean][] = [
    ["another install's entry", process.execPath, [otherEntry, "supervise", "--space", space], baseline],
    ["another install's bin symlink", process.execPath, [otherShim, "supervise", "--space", space], baseline],
    ["another install's entry behind a loader", process.execPath, ["--import", loader, otherEntry, "supervise", "--space", space], baseline],
    ["this process's entry", process.execPath, ["-e", idle, thisEntry, "supervise", "--space", space], true],
    ["this process's entry under another node binary", otherNode, ["-e", idle, thisEntry, "supervise", "--space", space], true],
    ["this process's entry behind a loader", process.execPath, ["--import", loader, "-e", idle, thisEntry, "supervise", "--space", space], true],
    ["an entry that cannot be told apart", process.execPath, ["-e", idle, "cotal.js", "supervise", "--space", space], true],
  ];
  for (const [what, exe, args, expected] of cases) {
    decoy = spawn(exe, args, { stdio: "ignore", cwd: root });
    await once(decoy, "spawn");
    assert.equal(supervisorMayServe(space), expected, `${what}: ${expected ? "is read as a supervisor of this install" : "adds no custody for this install"}`);
    decoy.kill("SIGKILL");
    await once(decoy, "exit");
    decoy = undefined;
  }
  console.log(`update-remote-custody: ok (${outcome.slice(0, 160)})`);
  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  decoy?.kill("SIGKILL");
  other?.kill("SIGKILL");
  broker.close();
  exchange.close();
  idpServer.close();
  rmSync(root, { recursive: true, force: true });
}
