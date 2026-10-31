/**
 * `channel_replies: false`: a turn's reply to a channel message is not posted, the channel message
 * tells the model so, and DM replies still reach their peer.
 *
 * The probe drives the real CotalAdapter with a stub gateway. Its control runs the default, where
 * a channel reply is posted.
 *
 * Run: pnpm smoke:hermes-channel-replies
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

const EXPECTED_CELLS = 23;
if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./channel-replies.probe.py", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) skipSuite("Python is unavailable for the Hermes adapter probe");
const pythonBin = python;

type Sent = { target: { peerId?: string; channel?: string }; text: string };
type ProbeResult = {
  channel_note: boolean;
  dm_note: boolean;
  channel_reply_ok: boolean;
  sent: Sent[];
  unanchored_sent: Sent[];
  answer_sent: Sent[];
};

function run(mode: "subject" | "control" | "shared"): ProbeResult {
  const res = spawnSync(pythonBin, [probe, `${pkgDir}plugin`, mode], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) console.error(`the ${mode} probe exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
  hard(res.status === 0, `the ${mode} probe ran`);
  const line = res.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  hard(line, `the ${mode} probe reported a result`);
  return JSON.parse(line.slice("RESULT ".length)) as ProbeResult;
}

const dmReply: Sent = { target: { peerId: "ada-id" }, text: "hello Ada" };
const explicit: Sent[] = [
  { target: { channel: "general" }, text: "explicit channel send" },
  { target: { channel: "general" }, text: "anchored to a DM" },
];

for (const mode of ["subject", "shared"] as const) {
  const r = run(mode);
  assert.deepEqual(r.sent, [dmReply, ...explicit], `${mode}: the reply to a channel message is dropped; DM replies and explicit sends post`);
  assert.equal(r.channel_reply_ok, true, `${mode}: a dropped channel reply reports success, so the gateway does not retry`);
  assert.equal(r.channel_note, true, `${mode}: a channel message tells the model its reply is not posted`);
  assert.equal(r.dm_note, false, `${mode}: a DM carries no channel note`);
  // Per-peer, an unanchored send names its chat like an explicit send (cron), so it still posts.
  const unanchored = mode === "shared" ? [] : [{ target: { channel: "ops" }, text: "unanchored" }];
  assert.deepEqual(r.unanchored_sent, unanchored, `${mode}: an unanchored send follows the chat it names`);
  // Shared: the answer to a question asked in a channel turn reports back to that channel, so it is dropped.
  const answer = mode === "shared" ? [] : [{ target: { channel: "ops" }, text: "answer turn reply" }];
  assert.deepEqual(r.answer_sent, answer, `${mode}: an answer turn whose origin is a channel follows channel_replies`);
}

const control = run("control");
assert.deepEqual(
  control.sent,
  [
    { target: { channel: "ops" }, text: "not for me" },
    dmReply,
    ...explicit,
  ],
  "control: by default a channel reply is posted",
);
assert.equal(control.channel_note, false, "control: by default a channel message carries no note");
assert.equal(control.dm_note, false, "control: a DM carries no note");
assert.deepEqual(
  control.unanchored_sent,
  [{ target: { channel: "ops" }, text: "unanchored" }],
  "control: by default an unanchored send in a channel turn is posted",
);
assert.deepEqual(
  control.answer_sent,
  [{ target: { channel: "ops" }, text: "answer turn reply" }],
  "control: by default an answer turn whose origin is a channel is posted",
);

console.log("hermes channel replies: channel posts are tool-only when channel_replies is false");
if (cells !== EXPECTED_CELLS) {
  console.error(`SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}.`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length + 1}`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length}`);
if (failures.length) {
  console.error(`hermes channel replies: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
