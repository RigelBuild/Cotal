/**
 * `single_session`: every mesh message runs in one Hermes session, each reply reaches the origin
 * of the message it answers, and a message that arrives mid-turn waits for the turn to end.
 *
 * The probe drives the real CotalAdapter with a stub gateway. Its control runs the per-peer
 * default, where the reply target comes from the chat id and a mid-turn message is not held.
 *
 * Run: pnpm smoke:hermes-single-session
 */
import { strict as nodeAssert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

let cells = 0;
const failures: string[] = [];
const assert: typeof nodeAssert = new Proxy(nodeAssert, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      cells += 1;
      const name = String(args.at(-1) ?? `assertion ${cells}`).replace(/[\r\n]/g, " ").slice(0, 160);
      try {
        const out = (value as (...items: unknown[]) => unknown).apply(target, args);
        console.log(`  ✓ ${name}`);
        return out;
      } catch {
        console.log(`  ✗ ${name}`);
        failures.push(name);
        return undefined;
      }
    };
  },
}) as typeof nodeAssert;

function hard(condition: unknown, name: string): asserts condition {
  cells += 1;
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  console.log(`  ✗ ${name}`);
  throw new Error(name);
}

const EXPECTED_CELLS = 25;
if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./single-session.probe.py", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) skipSuite("Python is unavailable for the Hermes adapter probe");
const pythonBin = python;

type Target = { peerId?: string; channel?: string };
type ProbeResult = {
  one_session: boolean;
  sender_kept: boolean;
  channel_named: boolean;
  reply_targets: Target[];
  held_mid_turn: boolean;
  runs_after_turn: boolean;
  unanchored_target: Target | null;
  error_notice_target: Target | null;
  explicit_target: Target | null;
  orphan_send_refused: boolean;
  idless_target: Target | null;
  dup_waits: boolean;
  held_once: boolean;
  answer_targets: (Target | null)[];
};

function run(mode: "subject" | "control"): ProbeResult {
  const res = spawnSync(pythonBin, [probe, `${pkgDir}plugin`, mode], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) console.error(`the ${mode} probe exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
  hard(res.status === 0, `the ${mode} probe ran`);
  const line = res.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  hard(line, `the ${mode} probe reported a result`);
  const parsed = JSON.parse(line.slice("RESULT ".length)) as ProbeResult;
  hard(Array.isArray(parsed.reply_targets) && parsed.reply_targets.length === 3, `the ${mode} probe sent three replies`);
  return parsed;
}

const subject = run("subject");
const control = run("control");
const expected: Target[] = [{ peerId: "ada-id" }, { peerId: "bob-id" }, { channel: "ops" }];

assert.equal(subject.one_session, true, "two peers and a channel share one session");
assert.equal(subject.sender_kept, true, "each message keeps its real sender");
assert.equal(subject.channel_named, true, "a channel message names its channel in the shared session");
assert.deepEqual(subject.reply_targets, expected, "each reply reaches the origin of the message it answers");
assert.equal(subject.held_mid_turn, true, "a DM arriving mid-turn waits instead of interrupting");
assert.equal(subject.runs_after_turn, true, "the held DM runs once the turn ends");
assert.deepEqual(subject.unanchored_target, { peerId: "bob-id" }, "an unanchored send goes to the running turn's origin");
assert.deepEqual(subject.error_notice_target, { peerId: "bob-id" }, "a turn-error notice after the turn ends still reaches that turn's origin");
assert.deepEqual(subject.explicit_target, { channel: "general" }, "a send naming its own chat goes there, not to the last peer");
assert.equal(subject.orphan_send_refused, true, "before any turn, an unanchored send is refused, not sent to a guess");
assert.deepEqual(subject.idless_target, { peerId: "dee-id" }, "an id-less message's reply reaches its sender by receive key");
assert.equal(subject.dup_waits, true, "a held message pushed again is not acked before its turn is admitted");
assert.equal(subject.held_once, true, "a held message pushed again runs one turn, not two");
assert.deepEqual(subject.answer_targets, [{ peerId: "ada-id" }, { channel: "ops" }], "an answer reports to the asking turn's origin: the DM peer, or the channel");

assert.equal(control.one_session, false, "the default keeps one session per peer and channel");
assert.notDeepEqual(control.reply_targets, expected, "routing by chat id in one session would misroute replies");
assert.equal(control.held_mid_turn, false, "the default does not hold a message for another session's turn");
assert.equal(control.runs_after_turn, true, "the default delivers the second DM");
assert.equal(control.held_once, false, "without the hold, a second push runs a second turn");

console.log("hermes single session: one context across peers, replies to each origin, mid-turn DMs queued");
if (cells !== EXPECTED_CELLS) {
  console.error(`SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}.`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length + 1}`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length}`);
if (failures.length) {
  console.error(`hermes single session: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
