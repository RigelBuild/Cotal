import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { LaunchSpec } from "@cotal-ai/core";
import { HolderRuntime } from "./src/holder.js";

// The Darwin branch of the holder runtime. Identity comes from
// `wave-host process-identity --pid N` and stop from
// `wave-host seat-stop --name NAME`. Neither /proc nor systemctl runs here.

const holder = "/fake/wave-seat-holder";
const waveHost = "/fake/wave-host";
const seatName = "ztest-darwin";
const launchSpec: LaunchSpec = { command: "node", args: ["agent"] };
let checks = 0;

type ExecCall = { file: string; args: string[]; cwd?: string; timeout?: number };
type FixtureOptions = {
  readonly waveHostError?: Error;
  readonly unreadablePid?: number;
};

function fixture(options: FixtureOptions = {}) {
  // pid -> start token as wave-host process-identity prints it.
  const tokens = new Map<number, string>([[101, "1700000000000011"], [202, "1700000000000022"]]);
  const calls: ExecCall[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const launcherDirs: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const runtime = new HolderRuntime({
    platform: "darwin",
    holderCommand: () => holder,
    waveHostCommand: () => waveHost,
    execFileSync: (file: string, args: string[], execOptions: { cwd?: string; timeout?: number }) => {
      if (file === holder && args[0] === "start" && execOptions.cwd !== undefined) launcherDirs.push(execOptions.cwd);
      calls.push({
        file,
        args,
        ...(execOptions.cwd === undefined ? {} : { cwd: execOptions.cwd }),
        ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
      });
      if (file === holder && args[0] === "start") return "101 202\n";
      if (file === waveHost && args[0] === "process-identity") {
        const pid = Number(args[args.indexOf("--pid") + 1]);
        if (pid === options.unreadablePid) throw Object.assign(new Error("denied"), { status: 1 });
        const token = tokens.get(pid);
        if (token === undefined) throw Object.assign(new Error("absent"), { status: 3 });
        return `${token}\n`;
      }
      if (file === waveHost && options.waveHostError !== undefined) throw options.waveHostError;
      return "";
    },
    kill: (pid: number, signal: NodeJS.Signals) => kills.push({ pid, signal }),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const cleanup = () => {
    for (const dir of launcherDirs) rmSync(dir, { recursive: true, force: true });
  };
  return { runtime, tokens, calls, kills, sleeps, cleanup, spawn: () => runtime.spawn(seatName, launchSpec, process.cwd()) };
}

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  checks++;
  console.log(`  ✓ ${name}`);
}

await check("darwin identity reads wave-host process-identity, never /proc or systemctl", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    assert.equal(handle.reference?.id, `${seatName}:101:1700000000000011:202:1700000000000022`);
    assert.ok(f.calls.some((call) => call.file === waveHost && call.args[0] === "process-identity" && call.args.includes("101")));
    assert.equal(f.calls.some((call) => call.file === "systemctl"), false);
  } finally {
    f.cleanup();
  }
});

await check("darwin status is exited only after both token-verified identities are absent", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.tokens.delete(101);
    assert.equal(handle.status(), "running");
    f.tokens.delete(202);
    assert.equal(handle.status(), "exited");
  } finally {
    f.cleanup();
  }
});

await check("darwin starttime mismatch counts as a dead identity", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.tokens.set(202, "1700000000000023");
    assert.equal(handle.status(), "running");
    f.tokens.delete(101);
    assert.equal(handle.status(), "exited");
  } finally {
    f.cleanup();
  }
});

await check("darwin unreadable identity is never reported gone", () => {
  const f = fixture({ unreadablePid: 202 });
  try {
    const handle = f.spawn();
    f.tokens.delete(101);
    assert.equal(handle.status(), "running");
  } finally {
    f.cleanup();
  }
});

await check("darwin graceful stop calls wave-host seat-stop, never systemctl", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    handle.stop({ graceful: true });
    assert.deepEqual(f.calls.at(-1), { file: waveHost, args: ["seat-stop", "--name", seatName], timeout: 15_000 });
    assert.equal(f.calls.some((call) => call.file === "systemctl"), false);
  } finally {
    f.cleanup();
  }
});

await check("darwin forced stop kills the verified agent pid, then seat-stops", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    handle.stop({ graceful: false });
    assert.deepEqual(f.kills, [{ pid: 202, signal: "SIGKILL" }]);
    assert.deepEqual(f.calls.at(-1), { file: waveHost, args: ["seat-stop", "--name", seatName], timeout: 15_000 });
  } finally {
    f.cleanup();
  }
});

await check("darwin never SIGKILLs a reused agent pid whose token changed", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    // The holder stays alive, but pid 202 now belongs to another process.
    f.tokens.set(202, "1700000000000099");
    handle.stop({ graceful: false });
    assert.deepEqual(f.kills, []);
  } finally {
    f.cleanup();
  }
});

await check("darwin stop on an exited seat does not call seat-stop", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.tokens.clear();
    f.calls.length = 0;
    assert.doesNotThrow(() => handle.stop({ graceful: true }));
    assert.equal(f.calls.filter((call) => call.file === waveHost && call.args[0] === "seat-stop").length, 0);
  } finally {
    f.cleanup();
  }
});

await check("darwin seat-stop failure is rethrown while an identity survives", () => {
  const failure = new Error("seat-stop failed");
  const f = fixture({ waveHostError: failure });
  try {
    const handle = f.spawn();
    assert.throws(() => handle.stop({ graceful: true }), failure);
  } finally {
    f.cleanup();
  }
});

await check("darwin reap retains when an identity survives forced teardown", async () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    const reference = handle.reference;
    assert.ok(reference);
    const evidence = await f.runtime.reap(reference);
    assert.equal(evidence.outcome, "retained");
    assert.equal(evidence.outcome === "retained" && evidence.reason, "members-remain");
    assert.equal(f.sleeps.length, 30);
  } finally {
    f.cleanup();
  }
});

await check("darwin reap reaps when both identities are absent", async () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    const reference = handle.reference;
    assert.ok(reference);
    f.tokens.clear();
    assert.equal((await f.runtime.reap(reference)).outcome, "reaped");
  } finally {
    f.cleanup();
  }
});

await check("darwin spawn refuses before holder start when wave-host is unavailable", () => {
  const calls: string[] = [];
  const runtime = new HolderRuntime({
    platform: "darwin",
    holderCommand: () => holder,
    waveHostCommand: () => undefined,
    execFileSync: (file: string) => {
      calls.push(file);
      return "101 202\n";
    },
  });
  assert.throws(() => runtime.spawn(seatName, launchSpec, process.cwd()), (error: unknown) =>
    error instanceof Error && error.name === "SpawnRefused" && /wave-host/.test(error.message),
  );
  assert.deepEqual(calls, [], "holder start must not run when wave-host is unresolved");
});

console.log(`HOLDER DARWIN PACKAGE TESTS: ${checks} tests executed`);
