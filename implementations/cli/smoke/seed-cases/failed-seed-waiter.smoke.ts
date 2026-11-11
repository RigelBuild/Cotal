import { spawn, existsSync, mkdtempSync, symlinkSync, tmpdir, join, BIN, HOST_ENV, freshCfg, seedDir, track, check, finishScenario } from "./harness.js";

// A holder process takes the real reconcile lock, writes a failed cursor under it, and releases the
// lock after HOLD_MS. An auto run that starts while it holds the lock waits on it, then finds the
// failed cursor only once it has the lock. That is the under-lock repair switch in `runUnderLocks`.
const HOLD_MS = 4000;
const HOLDER = `
import { acquireLock } from "@cotal-ai/workspace";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HOLDER_SEED_DIR;
mkdirSync(dir, { recursive: true });
const lock = acquireLock(join(dir, "reconcile.lock"), { label: "the failed-seed waiter holder", waitMs: 5000 });
const cursor = join(dir, "reconcile.cursor.json");
writeFileSync(cursor + ".tmp", JSON.stringify({ nonce: lock.nonce, package: "claude", phase: "add", failed: "npm is not on PATH" }));
renameSync(cursor + ".tmp", cursor);
console.log("ready");
setTimeout(() => { lock.release(); process.exit(0); }, Number(process.env.HOLDER_HOLD_MS));
`;

interface BootResult {
  readonly status: number;
  readonly stderr: string;
}

function bootAsync(cfg: string, extraEnv: Record<string, string>): Promise<BootResult> {
  const { promise, resolve, reject } = Promise.withResolvers<BootResult>();
  const child = spawn("node", [BIN, "sync"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1", ...extraEnv },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => { stderr += d; });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status: status ?? -1, stderr }));
  return promise;
}

async function run(): Promise<void> {
  // ── an auto run that waits on a live reconcile retries the seed that run failed, under the lock ──
  const cfg = track(freshCfg());
  // `node` and nothing else on PATH, so the repair's `npm install` cannot start and the retry fails fast.
  const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-waiter-no-npm-")));
  symlinkSync(process.execPath, join(bin, "node"));

  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const holder = spawn(process.execPath, ["--input-type=module", "-e", HOLDER], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...HOST_ENV, HOLDER_SEED_DIR: seedDir(cfg), HOLDER_HOLD_MS: String(HOLD_MS) },
  });
  holder.stdout.setEncoding("utf8");
  holder.stdout.on("data", (d: string) => { if (d.includes("ready")) ready.resolve(); });
  holder.on("exit", (code) => {
    ready.reject(new Error(`lock holder exited (${code}) before it was ready`));
    exited.resolve();
  });
  await ready.promise;

  const waiter = await bootAsync(cfg, { PATH: bin });
  await exited.promise;

  const recovering = waiter.stderr.match(/recovering from a failed seed \(package "claude"\)/g) ?? [];
  check("failed seed waiter: the waiting auto run prints exactly one recovering line",
    recovering.length === 1, waiter.stderr);
  check("failed seed waiter: the waiting auto run does not report an interrupted seed",
    !/was interrupted/.test(waiter.stderr), waiter.stderr);
  check("failed seed waiter: the retry under the lock reaches the failing npm install",
    waiter.status !== 0 && /npm install failed: npm is not on PATH/.test(waiter.stderr), waiter.stderr);
  check("failed seed waiter: the failed cursor is kept for the next retry",
    existsSync(join(seedDir(cfg), "reconcile.cursor.json")), waiter.stderr);
}

run().finally(finishScenario);
