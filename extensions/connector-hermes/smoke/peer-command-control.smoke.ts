/**
 * Peer messages must stay as text for the model, never gateway commands or approvals.
 *
 * The probe drives the real CotalAdapter._inject path with a stub gateway MessageEvent. Its
 * control removes the constructor keyword and confirms the upstream True default.
 *
 * Run: pnpm smoke:hermes-peer-command-control
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

const EXPECTED_CELLS = 14;
if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./peer-command-control.probe.py", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) skipSuite("Python is unavailable for the Hermes adapter probe");
const pythonBin = python;

const KEYS = ["dm_approve", "channel_approve", "dm_yes", "channel_yes"] as const;
type ProbeResult = Record<(typeof KEYS)[number], boolean>;

function isProbeResult(value: unknown): value is ProbeResult {
  if (typeof value !== "object" || value === null) return false;
  return KEYS.every((key) => typeof Object.getOwnPropertyDescriptor(value, key)?.value === "boolean");
}

function run(mode: "subject" | "control"): ProbeResult {
  const res = spawnSync(pythonBin, [probe, `${pkgDir}plugin`, mode], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) console.error(`the ${mode} probe exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
  hard(res.status === 0, `the ${mode} probe ran`);
  const line = res.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  hard(line, `the ${mode} probe reported a result`);
  const parsed: unknown = JSON.parse(line.slice("RESULT ".length));
  hard(isProbeResult(parsed), `the ${mode} result contains gateway-control values for every case`);
  return parsed;
}

const subject = run("subject");
const control = run("control");

for (const key of KEYS) {
  assert.equal(subject[key], false, `peer ${key} reaches the model without gateway control`);
  assert.equal(control[key], true, `old construction defaults ${key} to gateway control`);
}

console.log("hermes peer command control: injected peer text cannot control the gateway");
if (cells !== EXPECTED_CELLS) {
  console.error(`SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}.`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length + 1}`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failures.length} failed=${failures.length}`);
if (failures.length) {
  console.error(`hermes peer command control: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
