import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { RuntimeReapEvidence as ManagerRuntimeReapEvidence } from "../../implementations/manager/src/runtime/index.js";
import { isCustodialRuntime } from "../../implementations/manager/src/runtime/index.js";
import { HolderRuntime, holderRuntimeProvider } from "./src/holder.js";

const reapEvidenceTypeCheck = {
  absent: { outcome: "absent" },
  reaped: { outcome: "reaped", detail: "test" },
  retained: { outcome: "retained", reason: "unprovable", detail: "test" },
} satisfies Record<string, ManagerRuntimeReapEvidence>;

type ExecOptions = { cwd?: string; encoding: "utf8"; timeout?: number };
type ExecCall = { file: string; args: string[]; cwd?: string; timeout?: number };
type FixtureOptions = {
  readonly startError?: Error;
  readonly systemctlError?: Error;
  readonly onExec?: (file: string, args: string[], proc: Map<number, string>) => void;
};

const holder = "/fake/wave-seat-holder";
const seatName = "ztest-holder";
const launchSpec: LaunchSpec = { command: "node", args: ["agent"] };
let checks = 0;

function stat(pid: number, startTime: number): string {
  const fields = Array.from({ length: 19 }, (_, index) => String(index + 1));
  fields[18] = String(startTime);
  return `${pid} (fake seat process) S ${fields.join(" ")}\n`;
}

function fixture(options: FixtureOptions = {}) {
  const proc = new Map<number, string>([[101, stat(101, 11)], [202, stat(202, 22)]]);
  const calls: ExecCall[] = [];
  const sleeps: number[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const launcherDirs: string[] = [];
  let clock = 0;
  const runtime = new HolderRuntime({
    holderCommand: () => holder,
    unitPrefix: () => "wave-seat-",
    execFileSync: (file: string, args: string[], execOptions: ExecOptions) => {
      if (file === holder && args[0] === "start" && execOptions.cwd !== undefined) launcherDirs.push(execOptions.cwd);
      calls.push({
        file,
        args,
        ...(execOptions.cwd === undefined ? {} : { cwd: execOptions.cwd }),
        ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
      });
      options.onExec?.(file, args, proc);
      if (file === holder && args[0] === "start") {
        if (options.startError !== undefined) throw options.startError;
        return "101 202\n";
      }
      if (file === "systemctl" && options.systemctlError !== undefined) throw options.systemctlError;
      return "";
    },
    fs: {
      readFileSync: (path: string) => {
        const match = /^\/proc\/(\d+)\/stat$/.exec(path);
        const pid = match?.[1] === undefined ? undefined : Number(match[1]);
        const content = pid === undefined ? undefined : proc.get(pid);
        if (content === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
        return content;
      },
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      options.onSleep?.(ms, proc);
      clock += ms;
    },
    now: () => clock,
    kill: (pid: number, signal: NodeJS.Signals) => kills.push({ pid, signal }),
  });

  const spawn = (spec = launchSpec) => runtime.spawn(seatName, spec, process.cwd());
  const cleanup = () => {
    for (const dir of launcherDirs) rmSync(dir, { recursive: true, force: true });
  };
  return { runtime, proc, calls, sleeps, kills, spawn, cleanup };
}

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  checks++;
  console.log(`  ✓ ${name}`);
}

await check("holder status is live without Zellij on PATH", () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  const f = fixture();
  try {
    const handle = f.spawn();
    assert.equal(handle.status(), "running");
    assert.deepEqual(f.calls.map((call) => call.file), [holder]);
  } finally {
    f.cleanup();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

await check("spawn passes the private launcher to holder and records both process identities", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    assert.equal(handle.kind, "holder");
    assert.equal(handle.pid, 202);
    assert.deepEqual(handle.reference, { kind: "holder", id: `${seatName}:101:11:202:22` });
    const call = f.calls[0];
    assert.deepEqual(call, {
      file: holder,
      args: ["start", "--name", seatName, "--", "./ztest-holder"],
      cwd: call?.cwd,
      timeout: 15_000,
    });
    assert.ok(call?.cwd);
  } finally {
    f.cleanup();
  }
});

await check("startup confirmation is refused before calling the holder", () => {
  const f = fixture();
  try {
    assert.throws(() => f.spawn({ ...launchSpec, confirm: "continue?" }), (error: unknown) =>
      error instanceof Error && error.name === "SpawnRefused",
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

await check("status exits only after both process identities are gone", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.proc.delete(101);
    assert.equal(handle.status(), "running");
    f.proc.delete(202);
    assert.equal(handle.status(), "exited");
  } finally {
    f.cleanup();
  }
});

await check("a starttime mismatch counts as a dead process identity", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.proc.set(202, stat(202, 23));
    assert.equal(handle.status(), "running");
    f.proc.delete(101);
    assert.equal(handle.status(), "exited");
  } finally {
    f.cleanup();
  }
});

await check("a dead reference reaps with proof", async () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    f.proc.clear();
    const reference = handle.reference;
    assert.ok(reference);
    assert.equal((await f.runtime.reap(reference)).outcome, "reaped");
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

await check("a malformed reference is absent", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.runtime.reap({ kind: "holder", id: "not-a-seat" }), { outcome: "absent" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

await check("holder exit 4 becomes the actionable SpawnRefused", () => {
  const f = fixture({ startError: Object.assign(new Error("holder exited 4"), { status: 4 }) });
  try {
    assert.throws(() => f.spawn(), (error: unknown) =>
      error instanceof Error && error.name === "SpawnRefused" &&
      error.message === `seat ${seatName} is already live; stop it with: systemctl --user stop wave-seat-${seatName}`,
    );
  } finally {
    f.cleanup();
  }
});

await check("holder runtime is not custodial", () => {
  const f = fixture();
  try {
    assert.equal(isCustodialRuntime(f.runtime), false);
  } finally {
    f.cleanup();
  }
});

await check("graceful and forced stop use the seat unit and verified agent pid", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    handle.stop({ graceful: true });
    assert.deepEqual(f.calls.at(-1), {
      file: "systemctl",
      args: ["--user", "stop", `wave-seat-${seatName}`],
    });
    handle.stop({ graceful: false });
    assert.deepEqual(f.kills, [{ pid: 202, signal: "SIGKILL" }]);
    assert.deepEqual(f.calls.at(-1), {
      file: "systemctl",
      args: ["--user", "kill", "-s", "SIGKILL", `wave-seat-${seatName}`],
    });
  } finally {
    f.cleanup();
  }
});

await check("stop on an exited seat does not throw or call systemctl", () => {
  const f = fixture({ systemctlError: new Error("unit no longer loaded") });
  try {
    const handle = f.spawn();
    f.proc.clear();
    assert.doesNotThrow(() => handle.stop({ graceful: true }));
    assert.doesNotThrow(() => handle.stop({ graceful: false }));
    assert.equal(f.calls.filter((call) => call.file === "systemctl").length, 0);
  } finally {
    f.cleanup();
  }
});

await check("systemctl failure is swallowed only after both identities exit", () => {
  const f = fixture({
    systemctlError: new Error("unit disappeared"),
    onExec: (file, args, proc) => {
      if (file === "systemctl" && args[1] === "stop") proc.clear();
    },
  });
  try {
    const handle = f.spawn();
    assert.doesNotThrow(() => handle.stop({ graceful: true }));
  } finally {
    f.cleanup();
  }
});

await check("systemctl failure is rethrown while a process identity survives", () => {
  const failure = new Error("systemctl stop failed");
  const f = fixture({ systemctlError: failure });
  try {
    const handle = f.spawn();
    assert.throws(() => handle.stop({ graceful: true }), failure);
  } finally {
    f.cleanup();
  }
});

await check("interrupt and attach use the native holder command", () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    handle.interrupt();
    assert.deepEqual(f.calls.at(-1), { file: holder, args: ["interrupt", "--name", seatName] });
    assert.throws(() => handle.attach(), /holder runtime: attach with wave-seat-holder attach/);
  } finally {
    f.cleanup();
  }
});

await check("waitForExit checks again after each one-second poll", async () => {
  let polls = 0;
  const f = fixture({ onSleep: (_ms, proc) => { polls++; if (polls === 1) proc.clear(); } });
  try {
    const handle = f.spawn();
    await handle.waitForExit?.();
    assert.deepEqual(f.sleeps, [1_000]);
    assert.equal(handle.status(), "exited");
  } finally {
    f.cleanup();
  }
});

await check("reap escalates after 30 seconds and reports a forced teardown", async () => {
  const f = fixture({ onExec: (file, args, proc) => { if (file === "systemctl" && args[1] === "kill") proc.clear(); } });
  try {
    const handle = f.spawn();
    const reference = handle.reference;
    assert.ok(reference);
    const evidence = await f.runtime.reap(reference);
    assert.equal(evidence.outcome, "reaped");
    assert.deepEqual(f.sleeps, Array.from({ length: 30 }, () => 1_000));
    assert.deepEqual(f.calls.slice(-2).map(({ args }) => args), [
      ["--user", "stop", `wave-seat-${seatName}`],
      ["--user", "kill", "-s", "SIGKILL", `wave-seat-${seatName}`],
    ]);
  } finally {
    f.cleanup();
  }
});

await check("reap reports retained when identities survive forced teardown", async () => {
  const f = fixture();
  try {
    const handle = f.spawn();
    const reference = handle.reference;
    assert.ok(reference);
    const evidence = await f.runtime.reap(reference);
    assert.equal(evidence.outcome, "retained");
    assert.deepEqual(evidence, {
      outcome: "retained",
      reason: "members-remain",
      detail: `wave-seat-${seatName} still has a live or unreadable process identity after forced stop`,
    });
  } finally {
    f.cleanup();
  }
});

await check("provider availability follows COTAL_HOLDER_COMMAND", () => {
  const previous = process.env.COTAL_HOLDER_COMMAND;
  try {
    delete process.env.COTAL_HOLDER_COMMAND;
    assert.equal(holderRuntimeProvider.available(), false);
    process.env.COTAL_HOLDER_COMMAND = holder;
    assert.equal(holderRuntimeProvider.available(), true);
  } finally {
    if (previous === undefined) delete process.env.COTAL_HOLDER_COMMAND;
    else process.env.COTAL_HOLDER_COMMAND = previous;
  }
});

console.log(`HOLDER PACKAGE TESTS: ${checks} tests executed`);
