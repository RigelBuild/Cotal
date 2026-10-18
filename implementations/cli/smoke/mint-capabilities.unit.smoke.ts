import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, DEV_OWNER, epRequestGrantRows, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity, registry, spawnCallerCapabilities, type EpCaller } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { runCli } from "../src/command.js";

class ExitSignal extends Error {}
async function runMint(argv: string[]): Promise<{ output: string; code: number }> {
  const output: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  let code = 0;
  console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { output.push(args.join(" ")); };
  process.exit = ((exitCode?: number) => { code = exitCode ?? 0; throw new ExitSignal(); }) as never;
  try {
    await runCli(registry, ["mint", ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
  return { output: output.join("\n"), code };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function addLifecycleUid(creds: string, uid: string): string {
  const jwt = jwtFromCreds(creds);
  const [header, payload, signature] = jwt?.split(".") ?? [];
  if (!jwt || !header || !payload || !signature) throw new Error("fixture creds have no compact user JWT");
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const claims = objectRecord(decoded);
  const nats = objectRecord(claims?.nats);
  const pub = objectRecord(nats?.pub);
  const allow = pub?.allow;
  if (!claims || !nats || !pub || !Array.isArray(allow) || !allow.every((row) => typeof row === "string"))
    throw new Error("fixture creds have no string publish allow-list");
  const updated = {
    ...claims,
    nats: { ...nats, pub: { ...pub, allow: [...allow, `cotal.main.dm_local-agent-${uid}`] } },
  };
  const replacement = `${header}.${Buffer.from(JSON.stringify(updated)).toString("base64url")}.${signature}`;
  return creds.replace(jwt, replacement);
}

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
  const firstPath = join(root, "first.creds");
  const firstResult = await runMint(["spawn-caller", "--out", firstPath]);
  assert.equal(firstResult.code, 0, firstResult.output);
  assert.match(firstResult.output, /capabilities:\s+spawn/);
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

  const remintedPath = join(root, "reminted.creds");
  const remintResult = await runMint(["spawn-caller", "--identity", firstPath, "--out", remintedPath]);
  assert.equal(remintResult.code, 0, remintResult.output);
  const remintedJwt = jwtFromCreds(readFileSync(remintedPath, "utf8"));
  assert.ok(remintedJwt);
  const remintedClaims = JSON.parse(Buffer.from(remintedJwt.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string; nats?: { pub?: { allow?: string[] } } };
  assert.equal(remintedClaims.sub, firstClaims.sub);
  const remintedUid = remintedClaims.nats?.pub?.allow?.find((subject) => /\.dm_/.test(subject))?.match(/\.dm_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/)?.[1];
  assert.equal(remintedUid, firstUid);

  const nextPath = join(root, "next.creds");
  const nextResult = await runMint(["spawn-caller", "--identity", firstPath, "--new-incarnation", "--out", nextPath]);
  assert.equal(nextResult.code, 0, nextResult.output);
  const nextJwt = jwtFromCreds(readFileSync(nextPath, "utf8"));
  assert.ok(nextJwt);
  const nextClaims = JSON.parse(Buffer.from(nextJwt.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string; nats?: { pub?: { allow?: string[] } } };
  assert.equal(nextClaims.sub, firstClaims.sub);
  const nextUid = nextClaims.nats?.pub?.allow?.find((subject) => /\.dm_/.test(subject))?.match(/\.dm_[A-Za-z0-9_]+-[A-Za-z0-9_]+-([a-z0-9]{26,32})$/)?.[1];
  assert.ok(nextUid);
  assert.notEqual(nextUid, firstUid);

  for (const [name, capability] of [["admin-caller", "admin"], ["unknown-caller", "unknown"]] as const) {
    writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ncapabilities: [${capability}]\n---\n`);
    const out = join(root, `${name}.creds`);
    const result = await runMint([name, "--out", out]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /unknown capability/);
    assert.equal(existsSync(out), false, `${capability} must be refused before writing creds`);
  }

  const missingNameOut = join(root, "missing-name.creds");
  const missingName = await runMint(["--out", missingNameOut]);
  assert.equal(missingName.code, 1, missingName.output);
  assert.match(missingName.output, /usage: cotal mint <name>/);
  assert.equal(existsSync(missingNameOut), false);

  const observerPath = join(root, "observer.creds");
  writeFileSync(observerPath, await mintCreds(auth, newIdentity(), "observer"));

  for (const profile of ["observer", "admin"]) {
    const out = join(root, `new-incarnation-${profile}.creds`);
    const result = await runMint(["some-agent", "--profile", profile, "--identity", observerPath, "--new-incarnation", "--out", out]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /--new-incarnation applies to the agent profile only/);
    assert.equal(existsSync(out), false);
  }

  const zeroUidOut = join(root, "zero-lifecycle-uid.creds");
  const zeroUid = await runMint(["spawn-caller", "--profile", "agent", "--identity", observerPath, "--out", zeroUidOut]);
  assert.equal(zeroUid.code, 1, zeroUid.output);
  assert.match(zeroUid.output, /no single agent lifecycle UID/);
  assert.equal(existsSync(zeroUidOut), false);

  const secondUid = mintLifecycleUid();
  assert.notEqual(secondUid, firstUid);
  const multipleUidPath = join(root, "multiple-lifecycle-uids.creds");
  writeFileSync(multipleUidPath, addLifecycleUid(firstCreds, secondUid));
  const multipleUidOut = join(root, "multiple-lifecycle-uids-remint.creds");
  const multipleUids = await runMint(["spawn-caller", "--profile", "agent", "--identity", multipleUidPath, "--out", multipleUidOut]);
  assert.equal(multipleUids.code, 1, multipleUids.output);
  assert.match(multipleUids.output, /no single agent lifecycle UID/);
  assert.equal(existsSync(multipleUidOut), false);
  console.log("MINT CAPABILITIES UNIT SMOKE OK");
} finally {
  process.chdir(cwd);
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  if (previousNoPrompt === undefined) delete process.env.COTAL_NO_PROMPT;
  else process.env.COTAL_NO_PROMPT = previousNoPrompt;
  rmSync(root, { recursive: true, force: true });
}
