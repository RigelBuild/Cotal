/**
 * Guards release-branch push concurrency. Reads top-level groups only; trigger detection is indentation-based.
 * PR superseding is not asserted; unknown expressions fail closed.
 * Run: pnpm smoke:workflow-concurrency; prove: pnpm mutation-proof --config bin/smoke/mutations/workflow-concurrency.json.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, ".github", "workflows");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

/** Pin the active workflow population and push-policy coverage. */
const EXPECTED_WORKFLOWS = 9;
const EXPECTED_PUSH_TO_MAIN = 4;
// Rigel merges land on rigel-release; upstream main remains a mirrored branch.
const RELEASE_BRANCH = "rigel-release";
const EXPECTED_GROUPED = 4;

/** What a concurrency key can be: absent, a literal, or one of the expressions this repo uses.
 *  `unknown` is deliberately terminal. */
type Resolved = { kind: "literal"; value: string } | { kind: "byEvent"; pr: string; push: string } | { kind: "unknown"; raw: string };

/**
 * Evaluate a concurrency value for the two events that reach these workflows.
 *
 * Only the forms actually present are understood. Anything else returns `unknown` and fails its
 * cell, which is the point: a future edit that introduces a third form gets a red here instead of
 * quietly falling outside the guard.
 */
function resolve(raw: string): Resolved {
  const v = raw.trim();
  if (!v.startsWith("${{")) return { kind: "literal", value: v };
  // `${{ github.event_name == 'pull_request' }}` -> true on PR, false on push.
  if (/^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/.test(v)) {
    return { kind: "byEvent", pr: "true", push: "false" };
  }
  // `${{ github.event_name == 'pull_request' && 'a' || 'b' }}` -> 'a' on PR, 'b' on push.
  const m = v.match(/^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}$/);
  if (m) return { kind: "byEvent", pr: m[1], push: m[2] };
  return { kind: "unknown", raw: v };
}

/** One `concurrency:` block: the workflow's own, or one job's. */
interface Group {
  /** `ci.yml` for the workflow's own group, `changesets.yml job publish` for a job's. */
  where: string;
  /** True for the short `concurrency: <string>` form, which cannot carry `queue`. */
  shortForm: boolean;
  cancel?: string;
  queue?: string;
}

interface Wf {
  file: string;
  /** True when a push to the release branch can start this workflow. */
  pushesMain: boolean;
  /** The workflow's own group, then each job's, in file order. */
  groups: Group[];
}

/** Read the mapping of the `concurrency:` key at `lines[at]`, whose key sits at `indent`. */
function readGroup(lines: string[], at: number, indent: string, where: string): Group {
  const g: Group = { where, shortForm: false };
  const head = lines[at].slice(indent.length + "concurrency:".length).trim();
  if (head !== "") {
    g.shortForm = true; // `concurrency: <string>` cannot carry cancel-in-progress or queue
    return g;
  }
  const member = new RegExp(`^${indent} {2}\\S`);
  const kvRe = new RegExp(`^${indent} {2}([a-z-]+):\\s*(.*)$`);
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) continue;
    if (!member.test(l)) break;
    const kv = l.match(kvRe);
    if (!kv) continue;
    if (kv[1] === "cancel-in-progress") g.cancel = kv[2].trim();
    if (kv[1] === "queue") g.queue = kv[2].trim();
  }
  return g;
}

/** Read concurrency blocks and whether push names the release branch. */
function parse(file: string): Wf {
  const text = readFileSync(join(DIR, file), "utf8");
  const lines = text.split("\n");

  const wf: Wf = { file, pushesMain: false, groups: [] };

  // `on:` block, to the next top-level key.
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s*\S/.test(l));
  if (onIdx >= 0) {
    let inPush = false;
    for (let i = onIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l) && l.trim() !== "") break; // dedent to a new top-level key
      if (/^\s{2}push:/.test(l)) inPush = true;
      else if (/^\s{2}\S/.test(l)) inPush = false;
      if (inPush && l.replace(/^\s+-\s*/, "").trim() === RELEASE_BRANCH && /^\s+-/.test(l)) wf.pushesMain = true;
      if (inPush && /branches:\s*\[(.*)\]/.exec(l)?.[1]?.split(",").some((b) => b.trim().replace(/^(['"])(.*)\1$/, "$2") === RELEASE_BRANCH)) wf.pushesMain = true;
    }
  }

  // The workflow's own `concurrency:` sits at column 0. A job's sits at column 4, under the job's
  // key at column 2 of `jobs:`.
  let inJobs = false;
  let job: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) continue;
    if (/^\S/.test(l)) {
      inJobs = /^jobs:\s*$/.test(l);
      job = undefined;
      if (/^concurrency:/.test(l)) wf.groups.push(readGroup(lines, i, "", file));
      continue;
    }
    if (!inJobs) continue;
    const key = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) job = key[1];
    else if (job && /^ {4}concurrency:/.test(l)) wf.groups.push(readGroup(lines, i, "    ", `${file} job ${job}`));
  }
  return wf;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
const all = files.map(parse);
const pushers = all.filter((w) => w.pushesMain);

console.log("A. the population, so no check below can pass by finding nothing");
check(`exactly ${EXPECTED_WORKFLOWS} workflow files (update deliberately if you added one)`,
  files.length === EXPECTED_WORKFLOWS, { found: files.length, files });
check(`exactly ${EXPECTED_PUSH_TO_MAIN} of them can be started by a push to ${RELEASE_BRANCH}`,
  pushers.length === EXPECTED_PUSH_TO_MAIN, { found: pushers.map((w) => w.file) });

const grouped = pushers.filter((w) => w.groups.length > 0);
check(`exactly ${EXPECTED_GROUPED} of those declare a concurrency group, so only those can evict`,
  grouped.length === EXPECTED_GROUPED, { found: grouped.map((w) => w.file) });

console.log("\nB. every release-push workflow that HAS a group queues rather than evicts");
// A workflow with no group cannot evict: nothing is grouped, so nothing is ever pending behind
// anything. It is checked above by count rather than waived silently here, so removing a group
// somewhere else shows up as a moved number rather than as one fewer cell.
// An in-flight release must finish publishing, so its group never cancels.
for (const w of grouped.filter((w) => w.file === "rigel-release.yml")) {
  check(`${w.file}: does not cancel an active release`, w.groups.every((g) => g.cancel === "false"));
}
for (const g of grouped.flatMap((w) => w.groups)) {
  // The short form is the trap `changesets.yml` and `installer.yml` sat in. It reads as a
  // deliberate minimal choice and silently selects `queue: single`, the evicting default.
  check(`${g.where}: uses the mapping form, so it can carry \`queue\``, !g.shortForm, { shortForm: g.shortForm });
  if (g.shortForm) continue;

  const q = g.queue === undefined ? undefined : resolve(g.queue);
  check(`${g.where}: declares \`queue\``, q !== undefined);
  if (!q) continue;
  check(`${g.where}: \`queue\` is a form this check understands`, q.kind !== "unknown", { raw: g.queue });
  const onPush = q.kind === "literal" ? q.value : q.kind === "byEvent" ? q.push : undefined;
  check(`${g.where}: resolves to max on a push to ${RELEASE_BRANCH} (got ${onPush ?? "unresolvable"})`, onPush === "max");
}

console.log("\nC. nothing can resolve to the forbidden pairing");
// `queue: max` together with `cancel-in-progress: true` is a workflow VALIDATION error, so a file
// that can reach that combination for any event does not merely misbehave, it fails to parse and
// the workflow stops running at all. Checked per event rather than per file, because both keys are
// event-conditional and a per-file glance cannot see the combination.
for (const g of all.flatMap((w) => w.groups)) {
  if (g.shortForm) continue;
  const q = g.queue === undefined ? { kind: "literal", value: "single" } as Resolved : resolve(g.queue);
  const c = g.cancel === undefined ? { kind: "literal", value: "false" } as Resolved : resolve(g.cancel);
  if (q.kind === "unknown" || c.kind === "unknown") {
    check(`${g.where}: both concurrency keys are resolvable`, false, { queue: g.queue, cancel: g.cancel });
    continue;
  }
  for (const ev of ["pr", "push"] as const) {
    const qv = q.kind === "literal" ? q.value : q[ev];
    const cv = c.kind === "literal" ? c.value : c[ev];
    check(`${g.where}: on ${ev === "pr" ? "pull_request" : "push"}, not (queue=max AND cancel-in-progress=true)`,
      !(qv === "max" && cv === "true"), { queue: qv, cancel: cv });
  }
}

console.log(`\n${fail === 0 ? "WORKFLOW CONCURRENCY SMOKE OK ✅" : "WORKFLOW CONCURRENCY SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
// Printed on BOTH outcomes, deliberately, and this is not cosmetic. The marker means the suite
// REACHED ITS END, not that it passed, which is what lets mutation-proof tell a real named red from
// a run that died in the middle and reddened for an unrelated reason. Gating it on success graded
// all three mutations INCONCLUSIVE: each was red and correctly named, and each was refused for
// having stopped early, because the only evidence it had not was the line this print withheld.
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
