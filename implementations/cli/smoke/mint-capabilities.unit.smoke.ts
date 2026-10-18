import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, DEV_OWNER, epRequestGrantRows, jwtFromCreds, registry, spawnCallerCapabilities, type EpCaller } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { runCli } from "../src/command.js";

await import("../src/index.js");
const root = mkdtempSync(join(tmpdir(), "cotal-mint-caps-unit-"));
const previousHome = process.env.COTAL_HOME;
const previousNoPrompt = process.env.COTAL_NO_PROMPT;
const cwd = process.cwd();
process.env.COTAL_HOME = root;
process.env.COTAL_NO_PROMPT = "1";
const agents = join(root, ".cotal", "agents");
mkdirSync(agents, { recursive: true });
writeFileSync(join(agents, "spawn-caller.md"), "---\nname: spawn-caller\ncapabilities: [spawn]\n---\n");
const auth = await createSpaceAuth("main");
saveSpaceAuth(authDir(root), auth);
recordMesh({ space: "main", server: "nats://127.0.0.1:1", root, mode: "auth", ts: new Date().toISOString(), origin: "manual" });

try {
  process.chdir(root);
  const lines: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  process.exit = ((code?: number) => { throw new Error(`unexpected exit ${code ?? 0}`); }) as never;
  try {
    await runCli(registry, ["mint", "spawn-caller", "--out", join(root, "first.creds")]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
  const output = lines.join("\n");
  assert.match(output, /capabilities:\s+spawn/);
  const firstPath = join(root, "first.creds");
  const firstCreds = readFileSync(firstPath, "utf8");
  const firstJwt = jwtFromCreds(firstCreds);
  assert.ok(firstJwt);
  const firstClaims = JSON.parse(Buffer.from(firstJwt.split(".")[1]!, "base64url").toString("utf8")) as {
    sub?: string;
    nats?: { tags?: string[]; pub?: { allow?: string[] } };
  };
  assert.ok(firstClaims.sub);
  const firstRows = firstClaims.nats?.pub?.allow ?? [];
  const firstUid = firstRows.find((subject) => /\.dm_/.test(subject))?.match(/\.dm_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/)?.[1];
  assert.ok(firstUid);
  const caller: EpCaller = { owner: DEV_OWNER, actor: firstClaims.sub, uid: firstUid };
  const expected = spawnCallerCapabilities(DEV_OWNER).flatMap((capability) => epRequestGrantRows("main", capability, caller));
  assert.ok(expected.every((row) => firstRows.includes(row)));

  const remintOutput: string[] = [];
  console.log = (...args: unknown[]) => { remintOutput.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { remintOutput.push(args.join(" ")); };
  const remintedPath = join(root, "reminted.creds");
  try {
    await runCli(registry, ["mint", "spawn-caller", "--identity", firstPath, "--out", remintedPath]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(cwd);
  }
  const remintedJwt = jwtFromCreds(readFileSync(remintedPath, "utf8"));
  assert.ok(remintedJwt);
  const remintedClaims = JSON.parse(Buffer.from(remintedJwt.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string; nats?: { pub?: { allow?: string[] } } };
  assert.equal(remintedClaims.sub, firstClaims.sub);
  const remintedUid = remintedClaims.nats?.pub?.allow?.find((subject) => /\.dm_/.test(subject))?.match(/\.dm_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/)?.[1];
  assert.equal(remintedUid, firstUid);

  const newIncarnationOutput: string[] = [];
  console.log = (...args: unknown[]) => { newIncarnationOutput.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { newIncarnationOutput.push(args.join(" ")); };
  const nextPath = join(root, "next.creds");
  process.chdir(root);
  try {
    await runCli(registry, ["mint", "spawn-caller", "--identity", firstPath, "--new-incarnation", "--out", nextPath]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
  }
  const nextJwt = jwtFromCreds(readFileSync(nextPath, "utf8"));
  assert.ok(nextJwt);
  const nextClaims = JSON.parse(Buffer.from(nextJwt.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string; nats?: { pub?: { allow?: string[] } } };
  assert.equal(nextClaims.sub, firstClaims.sub);
  const nextUid = nextClaims.nats?.pub?.allow?.find((subject) => /\.dm_/.test(subject))?.match(/\.dm_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/)?.[1];
  assert.ok(nextUid);
  assert.notEqual(nextUid, firstUid);
  console.log("MINT CAPABILITIES UNIT SMOKE OK");
} finally {
  process.chdir(cwd);
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  if (previousNoPrompt === undefined) delete process.env.COTAL_NO_PROMPT;
  else process.env.COTAL_NO_PROMPT = previousNoPrompt;
  rmSync(root, { recursive: true, force: true });
}
