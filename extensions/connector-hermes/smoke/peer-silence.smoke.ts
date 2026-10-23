/**
 * `peer_silence: true` gives every peer event `reply_expected` false, so a silence marker stays silent.
 * The control runs the default, where the adapter leaves the field to the gateway.
 *
 * Run: pnpm smoke:hermes-peer-silence
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

// 3 modes x (2 hard + 1 assert).
const EXPECTED_CELLS = 9;
if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./peer-silence.probe.py", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) skipSuite("Python is unavailable for the Hermes adapter probe");
const pythonBin = python;

type ProbeResult = { reply_expected: unknown[] };

function run(mode: "subject" | "control" | "shared"): ProbeResult {
  const res = spawnSync(pythonBin, [probe, `${pkgDir}plugin`, mode], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) console.error(`the ${mode} probe exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
  hard(res.status === 0, `the ${mode} probe ran`);
  const line = res.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  hard(line, `the ${mode} probe reported a result`);
  return JSON.parse(line.slice("RESULT ".length)) as ProbeResult;
}

for (const mode of ["subject", "shared"] as const) {
  assert.deepEqual(run(mode).reply_expected, [false, false], `${mode}: channel and DM events allow a silent answer`);
}
assert.deepEqual(
  run("control").reply_expected,
  ["unset", "unset"],
  "control: by default the adapter leaves reply_expected to the gateway",
);

console.log("hermes peer silence: a silence marker answering a peer stays silent when peer_silence is true");
if (cells !== EXPECTED_CELLS) {
  console.error(`SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}.`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length + 1}`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length}`);
if (failures.length) {
  console.error(`hermes peer silence: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
