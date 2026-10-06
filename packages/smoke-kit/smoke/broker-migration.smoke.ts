/**
 * THE MIGRATION GATE for #1008: every place this repo starts a `nats-server` must be claimable by
 * the reaper and killable by the teardown helper.
 *
 * Run: pnpm smoke:broker-migration   (no broker needed: this reads source, not `ps`)
 *
 * WHY THIS SUITE EXISTS AT ALL, given that #1008's five suites are already migrated. The five were
 * fixed and nothing was left behind to keep them fixed. The reaper's header states the standing
 * condition plainly: it "is only ever as complete as the migration that mints the token". So the
 * durable defect was never those five files, it was that the repo had no way to notice a SIXTH. A
 * gate naming filenames has that same blind spot by construction, so this one names none: it walks
 * `git ls-files` through {@link enumerateSpawnSites} and grades whatever it finds.
 *
 * THE CENTRAL CELL IS A CENSUS, NOT A LIST. `every spawn site is adopted` fails on a count and
 * prints the offenders it found. Add an untokened broker anywhere in the repo, in a file nobody here
 * has heard of, and this goes red on the commit that adds it.
 *
 * WHY A SELF-CHECK CELL SITS NEXT TO IT. A census over source is only as good as its parser, and a
 * parser that silently stopped recognizing spawn sites would report zero violations and read exactly
 * like a clean repo. That failure is invisible from the outside, so the detector is exercised
 * DIRECTLY against a synthesized untokened spawn: if the enumerator cannot see a planted violation,
 * the census above is worthless and this says so rather than passing quietly.
 *
 * WHAT THIS DOES NOT CLAIM. It proves argv carries the token and the handle is owned, which is what
 * the reaper and the helper each need. It does not prove a suite's normal-path `finally` is correct,
 * which is defect 1 in the helper's taxonomy and is not visible in a spawn site's shape.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SMOKE_BROKER_TOKEN, SMOKE_BROKER_PREFIX } from "@cotal-ai/smoke-kit";
import { EXEMPT_MARKER, enumerateSpawnSites, inScope, isAdopted } from "@cotal-ai/smoke-kit/spawn-sites";

const repo = join(import.meta.dirname, "..", "..", "..");
const failures: string[] = [];
let passed = 0;

function cell(name: string, run: () => void): void {
  try {
    run();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sites = enumerateSpawnSites(repo);
const scoped = sites.filter(inScope);
const unadopted = scoped.filter((s) => !isAdopted(s));

console.log(
  `  · enumerated ${sites.length} nats-server spawn sites in ${new Set(sites.map((s) => s.file)).size} files` +
    ` (${sites.filter((s) => s.shipped).length} shipped, ${sites.filter((s) => s.exempt).length} exempt, ${scoped.length} in scope)`,
);

// The population has to be non-trivial, or every cell below passes vacuously. A parser that matched
// nothing would report a perfectly clean repo, which is the one failure a census cannot survive.
cell("the enumerator finds the repo's spawn sites at all", () => {
  assert.ok(sites.length >= 100, `expected a three-figure population, saw ${sites.length}`);
  assert.ok(scoped.length >= 100, `expected most sites in scope, saw ${scoped.length}`);
});

// THE GATE. No filenames: whatever `git ls-files` currently holds.
cell("every spawn site is adopted: tokened argv and an owned handle", () => {
  const detail = unadopted
    .map((s) => `    ${s.file}:${s.line} [${s.argvPath}] ${s.tokened ? "" : "UNTOKENED "}${s.owned ? "" : "UNOWNED "}path=${s.pathExpr ?? "(none in argv)"}`)
    .join("\n");
  assert.equal(
    unadopted.length,
    0,
    `${unadopted.length} spawn site(s) start a broker the reaper cannot claim or the helper cannot kill:\n${detail}\n` +
      `  Fix: mint the argv path through SMOKE_BROKER_TOKEN and pass the child to teardownOnSignal,\n` +
      `  or mark a deliberate negative control with ${EXEMPT_MARKER}.`,
  );
});

// THE PARSER IS GRADED AGAINST HAND-READ SOURCE, not only against a synthetic fixture. A planted
// file exercises the shapes this suite chose to plant; real suites use shapes nobody thought to
// plant, and the detector has already been wrong about one of them: a `const port = ..., conf =
// join(dir, "x.conf")` declarator list read a correctly tokened suite as UNTOKENED until the
// resolver learned to split declarators. A false positive is not a harmless over-report here,
// because the cure for it is to relax the parser, and a parser relaxed in the wrong place stops
// seeing real violations. So both verdicts are pinned on sites whose source was read by hand.
const VERIFIED: ReadonlyArray<readonly [string, number, boolean, string]> = [
  ["bin/smoke/persona-announce.smoke.ts", 139, true, "conf path inside a token-minted dir, owned"],
  ["bin/smoke/persona-agent.smoke.ts", 158, true, "store dir minted from the token, owned"],
  ["packages/core/smoke/channels.smoke.ts", 60, true, "store dir under a token-minted dir"],
  ["packages/core/smoke/channels-auth.smoke.ts", 45, true, "conf bound in a declarator LIST under a tokened dir"],
  ["extensions/connector-core/smoke/transport-liveness-broker.smoke.ts", 50, true, "spawn inside a FACTORY whose callers own the handle"],
  ["implementations/manager/smoke/hosted-retirement-native.acceptance.ts", 588, true, "handle assigned THROUGH a tracker wrapper, then owned"],
  ["packages/core/smoke/endpoint-session.smoke.ts", 465, true, "non-JetStream broker given a tokened -sd purely as argv evidence"],
  // The repo is fully migrated, so a still-unadopted REAL site no longer exists to pin. The
  // negative direction is held by the planted-fixture cell below, which builds one on demand, and
  // by the exempt site here: the marker must suppress the verdict, not the enumeration.
  ["bin/smoke/reaper.smoke.ts", 510, false, "deliberate negative control, exempt by marker"],
];

cell("the enumerator's verdict matches source read by hand, in both directions", () => {
  const wrong: string[] = [];
  for (const [file, line, want, why] of VERIFIED) {
    const s = sites.find((x) => x.file === file && Math.abs(x.line - line) <= 3);
    if (s === undefined) {
      wrong.push(`${file}:${line} is no longer enumerated at its hand-verified location (${why})`);
      continue;
    }
    if (isAdopted(s) !== want) wrong.push(`${file}:${s.line} read as adopted=${isAdopted(s)}, hand-read says ${want} (${why}); tokened=${s.tokened} owned=${s.owned} argv=${s.argvPath}`);
  }
  assert.deepEqual(wrong, [], `the enumerator disagrees with hand-read source:\n    ${wrong.join("\n    ")}`);
});

// THE DETECTOR'S OWN PROOF. Synthesize a suite that spawns an untokened broker and require the
// enumerator to see it. Without this, a parser that stopped matching would report zero violations.
cell("the enumerator detects a newly added untokened spawn site", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-selfcheck-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "planted.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `const sd = mkdtempSync(join(tmpdir(), "cotal-sixth-suite-js-"));\n` +
        `const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", "4222", "-js", "-sd", sd], { stdio: "ignore" });\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });

    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, `expected the planted spawn to be enumerated, saw ${found.length}`);
    assert.equal(found[0]!.tokened, false, "the planted spawn mints no token, so it must read as untokened");
    assert.equal(found[0]!.owned, false, "the planted spawn takes no ownership, so it must read as unowned");
    assert.equal(isAdopted(found[0]!), false, "an untokened, unowned spawn must not read as adopted");
    assert.equal(found.filter(inScope).length, 1, "a planted test-file spawn must be in scope");

    // And the same site, once migrated, must read as CLEAN. A detector that called everything a
    // violation would also pass the cell above while being useless.
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), \`\${SMOKE_BROKER_TOKEN}sixth-js-\`));\n` +
        `const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", "4222", "-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(broker, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const fixed = enumerateSpawnSites(scratch);
    assert.equal(fixed.length, 1, "the migrated spawn is still one enumerated site");
    assert.equal(isAdopted(fixed[0]!), true, "a tokened, owned spawn must read as adopted");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A resolved binary is a spawn site only when it is the command argument of a spawner. Its argv
// and child ownership must still pass the same checks as a literal `nats-server` command.
cell("the enumerator classifies a locally resolved broker path", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-indirect-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const smokeDir = join(scratch, "smoke");
    execFileSync("mkdir", ["-p", smokeDir]);
    const planted = join(smokeDir, "indirect.smoke.ts");
    const binary =
      `const brokerRoot = process.env.SMOKE_BROKER_ROOT;\n` +
      `const brokerPath = brokerRoot ? (await resolveNatsServer()).bin : undefined;\n`;
    const indirectSpawn = `const broker = spawn(brokerPath, ["-js", "-sd", sd], { stdio: "ignore" });\n`;
    writeFileSync(planted, binary);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    assert.equal(enumerateSpawnSites(scratch).length, 0, "resolving a broker binary without spawning it is not a site");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        binary +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), "cotal-indirect-suite-js-"));\n` +
        indirectSpawn +
        `const release = teardownOnSignal(broker, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "the untokened indirect spawn is still enumerated");

    assert.equal(found[0]!.tokened, false, "the indirect command's args do not contain a token");
    assert.equal(found[0]!.owned, true, "the planted indirect child is handed to teardownOnSignal");
    assert.equal(isAdopted(found[0]!), false, "an untokened indirect spawn fails adoption");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const unrelatedHint = "nats-server SMOKE_BROKER_TOKEN";\n` +
        `const unrelatedPath = "/usr/bin/other-server";\n` +
        `const child = spawn(unrelatedPath, ["-js", "-sd", sd], { stdio: "ignore" });\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    assert.equal(enumerateSpawnSites(scratch).length, 0, "an unrelated binary does not become a broker site");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "assertion-js-"));\n` +
        `const child = spawn((await resolveNatsServer()).bin as string, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const asserted = enumerateSpawnSites(scratch);
    assert.equal(asserted.length, 1, "a direct resolver call with a type assertion is enumerated");
    assert.equal(isAdopted(asserted[0]!), true, "the direct asserted resolver spawn is tokened and owned");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "fallback-js-"));\n` +
        `const brokerPath = process.env.NATS_BIN ?? "nats-server";\n` +
        `const child = spawn(brokerPath, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const fallback = enumerateSpawnSites(scratch);
    assert.equal(fallback.length, 1, "a local broker-path fallback is enumerated");
    assert.equal(isAdopted(fallback[0]!), true, "the fallback broker path retains normal adoption checks");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "destructure-js-"));\n` +
        `const { bin: brokerPath } = await resolveNatsServer();\n` +
        `const child = spawn(brokerPath, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const destructured = enumerateSpawnSites(scratch);
    assert.equal(destructured.length, 1, "a destructured broker binary is enumerated");
    assert.equal(isAdopted(destructured[0]!), true, "the destructured broker path retains normal adoption checks");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "resolved-js-"));\n` +
        `const resolved = await resolveNatsServer();\n` +
        `const brokerPath = resolved.bin;\n` +
        `const child = spawn(brokerPath, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const intermediate = enumerateSpawnSites(scratch);

    assert.equal(intermediate.length, 1, "an intermediate resolver result is enumerated");
    assert.equal(isAdopted(intermediate[0]!), true, "the intermediate broker path retains normal adoption checks");
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "coalesce-js-"));\n` +
        `const brokerPath = process.env.NATS_BIN ?? "nats-server";\n` +
        `const child = spawn(brokerPath ?? "nats-server", ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const coalesced = enumerateSpawnSites(scratch);
    assert.equal(coalesced.length, 1, "the fallback expression is not obscured by similar identifier text");

    assert.equal(isAdopted(coalesced[0]!), true, "the coalesced broker command keeps normal adoption checks");
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), "regex-js-"));\n` +
        `const matcher = /needs this space's local seed/;\n` +
        `const child = spawn("nats-server", ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `void child;\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const regexBeforeSpawn = enumerateSpawnSites(scratch);
    assert.equal(regexBeforeSpawn.length, 1, "a regex before spawn does not hide the broker call");
    assert.equal(regexBeforeSpawn[0]!.tokened, false, "the regex control cannot fabricate argv token evidence");
    assert.equal(isAdopted(regexBeforeSpawn[0]!), false, "the untokened regex control fails adoption");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "template-js-"));\n` +
        `const rendered = \`\${(() => { const broker = spawn("nats-server", ["-js", "-sd", sd], { stdio: "ignore" }); teardownOnSignal(broker, sd); return ""; })()}\`;\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const templateSpawn = enumerateSpawnSites(scratch);
    assert.equal(templateSpawn.length, 1, "a spawn in executable template substitution is enumerated");
    assert.equal(isAdopted(templateSpawn[0]!), true, "a template-substitution spawn retains normal adoption checks");

    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "scope-js-"));\n` +
        `let conf = "";\n` +
        `function setConf() { conf = join(sd, "server.conf"); }\n` +
        `setConf();\n` +
        `const child = spawn("nats-server", ["-c", conf], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(child, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const assigned = enumerateSpawnSites(scratch);
    assert.equal(assigned.length, 1, "a helper assignment updates the declared outer binding");
    assert.equal(isAdopted(assigned[0]!), true, "the tokened helper-assigned config stays adopted");

  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator tracks reassignment origins and self-extending paths", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-assignment-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "assignment.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `let sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "assigned-js-"));\n` +
      `sd = join(sd, "nested");\n` +
      `const child = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });\n` +
      `const release = teardownOnSignal(child, sd);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const assigned = enumerateSpawnSites(scratch);
    assert.equal(assigned.length, 1, "the reassigned path keeps its spawn site");
    assert.equal(isAdopted(assigned[0]!), true, "the reassigned token origin reaches the argv path");
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const sd = mkdtempSync(join(tmpdir(), "plain-js-"));\n` +
      `sd = join(sd, SMOKE_BROKER_TOKEN);\n` +
      `const child = spawn("nats-server", ["-c", sd], { stdio: "ignore" });\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const selfExtended = enumerateSpawnSites(scratch);
    assert.equal(selfExtended.length, 1, "a self-extending path keeps its site");
    assert.equal(selfExtended[0]!.tokened, true, "self-extension preserves the earlier token origin");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator does not treat a comment as a version probe", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-version-comment-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "version-comment.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `const child = spawn("nats-server", ["-js", /* --version was considered here */ "-sd", "plain"]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "a comment in argv does not hide the broker spawn");
    assert.equal(found[0]!.argvPath, "store", "comment text does not spoof the --version probe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator does not infer resolver provenance through a loop-local binding", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-loop-shadow-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "loop-shadow.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `const bin = (await resolveNatsServer()).bin;\n` +
        `for (let bin of ["/usr/bin/other-server"]) { spawn(bin, ["-js", "-sd", "plain"]); }\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    assert.equal(enumerateSpawnSites(scratch).length, 0, "a for-of binding shadows the outer resolver binary");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator ignores resolver calls shadowed by a function parameter", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-resolver-shadow-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "resolver-shadow.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `const resolveNatsServer = async () => ({ bin: "/usr/bin/other-server" });\n` +
      `async function start(resolveNatsServer: () => Promise<{ bin: string }>) {\n` +
      `  spawn((await resolveNatsServer()).bin, ["-js", "-sd", "plain"]);\n` +
      `}\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    assert.equal(enumerateSpawnSites(scratch).length, 0, "a shadowed resolver call cannot classify another executable as NATS");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator binds same-name declarations to their lexical scopes", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-shadow-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "shadow.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const bin = (await resolveNatsServer()).bin;\n` +
        `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "shadow-js-"));\n` +
        `function startUnrelated() {\n` +
        `  const bin = "/usr/bin/other-server";\n` +
        `  const child = spawn(bin, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `  return child;\n` +
        `}\n` +
        `const broker = spawn(bin, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(broker, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const shadowed = enumerateSpawnSites(scratch);
    assert.equal(shadowed.length, 1, "an unrelated same-name declaration is not a broker site");
    assert.equal(isAdopted(shadowed[0]!), true, "the outer resolver-backed broker remains adopted");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator follows tokened provenance through later bindings and helper parameters", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-provenance-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "provenance.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `function start() { return spawn("nats-server", ["-c", sd]); }\n` +
      `function startBroker(dir: string) { return spawn("nats-server", ["-c", dir]); }\n` +
      `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "closure-js-"));\n` +
      `const closureChild = start();\n` +
      `const closureRelease = teardownOnSignal(closureChild, sd);\n` +
      `const parameterChild = startBroker(sd);\n` +
      `const parameterRelease = teardownOnSignal(parameterChild, sd);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 2, "both broker helpers are enumerated");
    assert.ok(found.every(isAdopted), "later captured bindings and same-name helper parameters retain token provenance");

    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "shadow-js-"));\n` +
      `function startBroker(sd: string) { return spawn("nats-server", ["-c", sd]); }\n` +
      `const child = startBroker("plain.conf");\n` +
      `const release = teardownOnSignal(child, sd);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const shadowed = enumerateSpawnSites(scratch);
    assert.equal(shadowed.length, 1, "the parameter-shadowed broker remains enumerated");
    assert.equal(shadowed[0]!.tokened, false, "a tokened outer variable cannot leak into a same-name parameter");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator follows destructured property provenance without borrowing siblings", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-destructured-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "destructured.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `function first({ path }: { path: string }, hint: string) { spawn("nats-server", ["-sd", path]); }\n` +
      `function second({ path, hint }: { path: string; hint: string }) { spawn("nats-server", ["-sd", path]); }\n` +
      `first({ path: "plain" }, SMOKE_BROKER_TOKEN);\n` +
      `second({ path: "plain", hint: SMOKE_BROKER_TOKEN });\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 2);
    assert.ok(found.every((site) => !site.tokened), "neither unrelated argument nor sibling property tokens path");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator sees dynamic-import and method broker launches", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-method-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "method.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `const { spawn: launch } = await import("node:child_process");\n` +
      `const binary = (await resolveNatsServer()).bin;\n` +
      `const direct = launch(binary, ["-sd", "plain"]);\n` +
      `class Broker { start(binary: string, path: string) { return launch(binary, ["-sd", path]); } }\n` +
      `const object = { start(binary: string, path: string) { return launch(binary, ["-sd", path]); } };\n` +
      `new Broker().start("nats-server", "plain"); object.start("nats-server", "plain");\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 3, "dynamic import and both method bodies must be counted");
    assert.ok(found.every((site) => !site.tokened), "method arguments remain untokened");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator ignores a tokened binding named like parser syntax", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-parser-name-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "parser-name.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const value = SMOKE_BROKER_TOKEN;\n` +
      `const child = spawn("nats-server", ["-sd", "plain"]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.tokened, false, "the scanner's parse wrapper cannot mint argv provenance");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator rejects a plain branch of a conditional path", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-conditional-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "conditional.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const tokenPath = join(tmpdir(), SMOKE_BROKER_TOKEN);\n` +
      `const plainPath = "plain";\n` +
      `const child = spawn("nats-server", ["-sd", process.env.ISOLATED ? tokenPath : plainPath]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.tokened, false, "each possible argv path must carry the token");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator does not borrow future outer assignments", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-future-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "future.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `let sd = "plain";\n` +
      `{ const child = spawn("nats-server", ["-sd", sd]); }\n` +
      `sd = join(tmpdir(), SMOKE_BROKER_TOKEN);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.tokened, false, "later assignment cannot token a previous launch");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator refuses omitted and callback helper paths", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-omitted-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "omitted.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const sd = join(tmpdir(), SMOKE_BROKER_TOKEN);\n` +
      `function start(path = "plain") { return spawn("nats-server", ["-sd", path]); }\n` +
      `start(sd); start(); ["plain"].forEach(start);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.tokened, false, "all helper invocation paths must be tokened");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator keeps reassignment provenance in the execution scope", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-assignment-scope-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "assignment-scope.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));\n` +
      `let conf = "";\n` +
      `function start() { const sd = "/plain"; conf = join(sd, "server.conf"); return spawn("nats-server", ["-c", conf]); }\n` +
      `const child = start();\n` +
      `const release = teardownOnSignal(child, sd);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "the helper assignment reaches its broker spawn");
    assert.equal(found[0]!.tokened, false, "a tokened outer binding cannot leak through an inner-scope assignment");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator rejects token spellings, lookalike ownership, and shadowed callbacks", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-false-provenance-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "false-provenance.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN as importedToken } from "@cotal-ai/smoke-kit";\n` +
      `const SMOKE_BROKER_TOKEN = "ordinary";\n` +
      `const sd = mkdtempSync(join(tmpdir(), importedToken));\n` +
      `function fabricatedToken() { const SMOKE_BROKER_TOKEN = "ordinary"; const plain = join(tmpdir(), SMOKE_BROKER_TOKEN); spawn("nats-server", ["-sd", plain]); }\n` +
      `const broker = spawn("nats-server", ["-sd", sd]);\n` +
      `// teardownOnSignal(broker)\n` +
      `const note = "teardownOnSignal(broker)";\n` +
      `const shadowed = { forEach: (callback: (sd: string) => void) => callback("plain") };\n` +
      `shadowed.forEach((sd) => spawn("nats-server", ["-sd", sd]));\n` +
      `const caught = mkdtempSync(join(tmpdir(), importedToken));\n` +
      `try { throw new Error(); } catch (caught) { spawn("nats-server", ["-sd", caught]); }\n` +
      `const launch = spawn;\n` +
      `const aliasChild = launch("nats-server", ["-sd", sd]);\n` +
      `function assignShadow() { let conf = ""; const sd = "/plain"; conf = join(sd, "server.conf"); spawn("nats-server", ["-c", conf]); }\n` +
      `void importedToken;\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 6, "factory, local, callback, catch, alias, and assignment sites are recognized");
    assert.equal(found[0]!.tokened, false, "the token-name spelling is not an imported token");
    assert.equal(found[1]!.tokened, true, "the imported-token local path is tokened");
    assert.equal(found[2]!.tokened, false, "a parameter shadows an outer imported token");
    assert.equal(found[3]!.tokened, false, "a catch parameter shadows an outer imported token");
    assert.equal(found[4]!.tokened, true, "the imported-token alias path remains tokened");
    assert.equal(found[5]!.tokened, false, "a nested assignment resolves the name in its execution scope");
    assert.ok(found.every((site) => !site.owned), "comments and strings cannot claim child ownership");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator ties ownership to the exact child binding", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-owner-binding-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "owner-binding.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `function nested() { const broker = spawn("nats-server", ["-sd", "plain"]); teardownOnSignal(broker); }\n` +
      `const broker = spawn("nats-server", ["-sd", "plain"]);\n` +
      `let reassigned = spawn("nats-server", ["-sd", "plain"]);\n` +
      `reassigned = spawn("nats-server", ["-sd", "other"]);\n` +
      `teardownOnSignal(reassigned);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 4, "both shadowed and reassigned child spawns remain census sites");
    assert.equal(found[0]!.owned, true, "the nested child has matching lexical teardown ownership");
    assert.equal(found[1]!.owned, false, "a nested binding cannot claim the outer same-name child");
    assert.equal(found[2]!.owned, false, "a teardown after reassignment cannot own the original child");
    assert.equal(found[3]!.owned, true, "the teardown owns the current reassigned child");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator rejects assignment and callback scope token leakage", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-shadow-barriers-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "shadow-barriers.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));\n` +
      `let conf = "";\n` +
      `function assignShadow() { const sd = "/plain"; conf = join(sd, "server.conf"); spawn("nats-server", ["-c", conf]); }\n` +
      `const rows = { forEach: (callback: (sd: string) => void) => callback("plain") };\n` +
      `rows.forEach((sd) => spawn("nats-server", ["-sd", sd]));\n` +
      `const other = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));\n` +
      `try { throw new Error(); } catch (other) { spawn("nats-server", ["-sd", other]); }\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 3, "nested assignment, callback, and catch starts remain census sites");
    assert.ok(found.every((site) => !site.tokened), "none can borrow the outer token through shadowed bindings");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator refuses a fake teardown", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-fake-owner-`));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const planted = join(scratch, "smoke", "fake-owner.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";\n` +
      `const sd = join(tmpdir(), SMOKE_BROKER_TOKEN);\n` +
      `const child = spawn("nats-server", ["-sd", sd]);\n` +
      `function teardownOnSignal(child: unknown) { void child; }\n` +
      `teardownOnSignal(child);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.owned, false, "a local no-op cannot claim broker ownership");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator binds actual child_process command aliases", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-spawn-alias-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "spawn-alias.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn as launch } from "node:child_process";\n` +
      `import * as childProcess from "child_process";\n` +
      `import defaultProcess from "node:child_process";\n` +
      `const first = launch("nats-server", ["-sd", "plain"]);\n` +
      `const second = childProcess.spawn("nats-server", ["-sd", "plain"]);\n` +
      `const third = childProcess["spawn"]("nats-server", ["-sd", "plain"]);\n` +
      `const fourth = defaultProcess.spawn("nats-server", ["-sd", "plain"]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 4, "named, namespace, computed and default process imports are census sites");
    assert.ok(found.every((site) => !site.tokened && !site.owned), "alias sites retain both adoption requirements");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator follows only genuine imported token bindings", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-import-token-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "import-token.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn as launch } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN as token, SMOKE_BROKER_PREFIX as prefix, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `const sd = mkdtempSync(join(tmpdir(), token));\n` +
      `const child = launch("nats-server", ["-sd", sd]);\n` +
      `const release = teardownOnSignal(child, sd);\n` +
      `const prefixChild = launch("nats-server", ["-sd", prefix + "plain"]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 2, "both imported token and prefix sites are enumerated");
    assert.equal(found[0]!.tokened, true, "the actual imported token alias carries provenance");
    assert.equal(found[0]!.owned, true, "code-only ownership binds the child");
    assert.equal(found[1]!.tokened, false, "the prefix alone cannot establish PID-capable adoption");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator recognizes binary lookups passed to local helpers", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-lookup-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "lookup.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `const locate = (name: string) => name;\n` +
      `const brokerPath = locate("nats-server");\n` +
      `const broker = spawn(brokerPath, ["-js", "-sd", "plain"]);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "a binary lookup passed through a local helper becomes a census site");
    assert.equal(isAdopted(found[0]!), false, "a binary lookup with a plain store path remains unadopted");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
cell("the enumerator traces shorthand return fields across same-name bindings", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-return-field-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "return-field.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(planted,
      `import { spawn } from "node:child_process";\n` +
      `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
      `function sandbox() { const cwd = join(SMOKE_BROKER_TOKEN, "plain-js"); return { cwd }; }\n` +
      `const { cwd } = sandbox();\n` +
      `const child = spawn("nats-server", ["-js", "-sd", cwd]);\n` +
      `const release = teardownOnSignal(child, cwd);\n`);
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "the shorthand-return broker is enumerated");
    assert.equal(isAdopted(found[0]!), true, "the returned field and its destructuring alias keep token provenance");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

cell("the enumerator resolves a ternary-bound NATS binary", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-ternary-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "ternary.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const brokerRoot = process.env.SMOKE_BROKER_ROOT;\n` +
        `const brokerPath = brokerRoot ? (await resolveNatsServer()).bin : undefined;\n` +
        `const sd = mkdtempSync(join(tmpdir(), \`\${SMOKE_BROKER_TOKEN}ternary-js-\`));\n` +
        `const broker = spawn(brokerPath, ["-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(broker, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, "the local ternary-bound resolver spawn is enumerated once");
    assert.equal(isAdopted(found[0]!), true, "the ternary-bound resolver retains argv and ownership checks");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The token the gate requires must be the one the reaper matches. Two literals that drift apart
// would leave every suite "migrated" against a prefix nothing reaps.
cell("the required token is the prefix the reaper matches", async () => {
  assert.ok(SMOKE_BROKER_TOKEN.startsWith(SMOKE_BROKER_PREFIX), "the minted token must carry the reaper's prefix");
  assert.match(SMOKE_BROKER_TOKEN, new RegExp(`^${SMOKE_BROKER_PREFIX}\\d+-$`), "the token must carry the owner pid the reaper parses");
});

console.log(`\n${failures.length === 0 ? "BROKER MIGRATION CHECKS PASSED" : "BROKER MIGRATION CHECKS FAILED"} (${passed} passed, ${failures.length} failed)`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  failed: ${f}`);
  process.exit(1);
}
