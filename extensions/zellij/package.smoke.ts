import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LaunchSpec } from "@cotal-ai/core";
import { buildNewPaneArgs, buildNewTabArgs } from "./src/driver.js";
import { parseZellijPlacement } from "./src/placement.js";
import { privateLauncher, ZellijRuntime } from "./src/runtime.js";
import * as zellij from "./src/driver.js";

let checks = 0;
const failures: string[] = [];
function check(name: string, condition: boolean): void {
  checks++;
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ FAIL: ${name}`);
  }
}

function rejects(name: string, raw: string): void {
  assert.throws(() => parseZellijPlacement(raw), undefined, name);
  checks++;
  console.log(`  ✓ ${name}`);
}

function readCalls(logPath: string): string[][] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function withFakeZellij(
  mode: "missing-session" | "partial-tab" | "confirm" | "no-server" | "probe-error" | "bad-tabs" | "dropped-pane" | "unavailable" | "slow-probe" | "no-client" | "slow-client" | "clients-error" | "clients-flaky" | "handoff",
  run: (logPath: string, session: string) => void | Promise<void>,
): Promise<void> {
  // The fake is a shebang script Windows cannot exec, and zellij ships no Windows build.
  if (process.platform === "win32") {
    console.log(`  ✓ win32: skipped fake-zellij scenario "${mode}" (zellij is POSIX-only)`);
    return;
  }
  const bin = mkdtempSync(join(tmpdir(), "cotal-zellij-fake-"));
  const executable = join(bin, "zellij");
  const logPath = join(bin, "calls.jsonl");
  const session = `ztest-fake-${process.pid}`;
  const saved = {
    PATH: process.env.PATH,
    mode: process.env.COTAL_ZELLIJ_TEST_MODE,
    session: process.env.COTAL_ZELLIJ_TEST_SESSION,
    log: process.env.COTAL_ZELLIJ_TEST_LOG,
    screen: process.env.COTAL_ZELLIJ_TEST_SCREEN,
    screenCount: process.env.COTAL_ZELLIJ_TEST_SCREEN_COUNT,
  };
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.COTAL_ZELLIJ_TEST_LOG, JSON.stringify(args) + "\\n");
if (process.env.COTAL_ZELLIJ_TEST_MODE === "unavailable") process.exit(1);
if (process.env.COTAL_ZELLIJ_TEST_MODE === "slow-probe") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
if (args[0] === "list-sessions") {
  const mode = process.env.COTAL_ZELLIJ_TEST_MODE;
  if (mode === "no-server") { console.error("No active zellij sessions found."); process.exit(1); }
  if (mode === "probe-error") { console.error("Error occurred: timed out"); process.exit(1); }
  console.log(mode === "missing-session" ? "other-session [Created 1s ago] " : process.env.COTAL_ZELLIJ_TEST_SESSION + " [Created 1s ago] ");
  process.exit(0);
}
const action = args[3];
if (action === "list-clients") {
  const mode = process.env.COTAL_ZELLIJ_TEST_MODE;
  if (mode === "slow-client") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  if (mode === "clients-error") { console.error("Error occurred: timed out"); process.exit(1); }
  if (mode === "clients-flaky") {
    const flag = process.env.COTAL_ZELLIJ_TEST_LOG + ".flaked";
    try { readFileSync(flag); } catch { writeFileSync(flag, "1"); console.error("Error occurred: timed out"); process.exit(1); }
  }
  if (mode === "handoff") {
    // Live headless clients count as zellij clients; the test file sets how many real clients exist.
    const command = "exec zellij attach " + process.env.COTAL_ZELLIJ_TEST_SESSION;
    const ours = readdirSync("/proc").filter((entry) => {
      try { return /^\\d+$/.test(entry) && readFileSync("/proc/" + entry + "/cmdline", "utf8").includes(command); } catch { return false; }
    }).length;
    const realPath = process.env.COTAL_ZELLIJ_TEST_LOG + ".clients";
    let real = 0;
    try { real = Number(readFileSync(realPath, "utf8")); } catch {}
    // "leave" models a real client that is gone by the next listing.
    try { readFileSync(realPath + ".leave"); writeFileSync(realPath, "0"); } catch {}
    console.log("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND");
    for (let id = 1; id <= ours + real; id++) console.log(id + " terminal_1 node");
    process.exit(0);
  }
  console.log(mode === "missing-session" || mode === "no-client" || mode === "slow-client" ? "not found" : "1");
  process.exit(0);
}
if (action === "new-tab") { console.log("77"); process.exit(0); }
// Placed panes get an ID zellij never adds; the unplaced retry lands as terminal_78.
if (action === "new-pane") { console.log(args.includes("--stacked") ? "terminal_99" : "terminal_78"); process.exit(0); }
if (action === "list-tabs") {
  if (process.env.COTAL_ZELLIJ_TEST_MODE === "bad-tabs") { console.log("not json"); process.exit(0); }
  console.log(JSON.stringify([{ tab_id: 77, name: "confirm-agent", active: true }]));
  process.exit(0);
}
if (action === "dump-screen") {
  const countPath = process.env.COTAL_ZELLIJ_TEST_SCREEN_COUNT;
  const reads = Number(readFileSync(countPath, "utf8") || "0") + 1;
  writeFileSync(countPath, String(reads));
  console.log(process.env.COTAL_ZELLIJ_TEST_SCREEN ?? (reads >= 3 ? "Continue?" : "booting"));
  process.exit(0);
}
if (action === "list-panes") {
  const mode = process.env.COTAL_ZELLIJ_TEST_MODE;
  console.log(JSON.stringify(mode === "partial-tab" ? [] : [{
    id: 77, tab_id: 77, title: "confirm-agent", is_plugin: false, exited: false, exit_status: null
  }, ...(mode === "dropped-pane" ? [{ id: 78, tab_id: 77, title: "", is_plugin: false, exited: false, exit_status: null }] : [])]));
  process.exit(0);
}
`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${saved.PATH ?? "/usr/bin:/bin"}`;
  process.env.COTAL_ZELLIJ_TEST_MODE = mode;
  process.env.COTAL_ZELLIJ_TEST_SESSION = session;
  process.env.COTAL_ZELLIJ_TEST_LOG = logPath;
  process.env.COTAL_ZELLIJ_TEST_SCREEN_COUNT = `${logPath}.screen-count`;
  writeFileSync(`${logPath}.screen-count`, "0");
  try {
    await run(logPath, session);
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = saved.PATH;
    if (saved.mode === undefined) delete process.env.COTAL_ZELLIJ_TEST_MODE;
    else process.env.COTAL_ZELLIJ_TEST_MODE = saved.mode;
    if (saved.session === undefined) delete process.env.COTAL_ZELLIJ_TEST_SESSION;
    else process.env.COTAL_ZELLIJ_TEST_SESSION = saved.session;
    if (saved.log === undefined) delete process.env.COTAL_ZELLIJ_TEST_LOG;
    else process.env.COTAL_ZELLIJ_TEST_LOG = saved.log;
    if (saved.screen === undefined) delete process.env.COTAL_ZELLIJ_TEST_SCREEN;
    else process.env.COTAL_ZELLIJ_TEST_SCREEN = saved.screen;
    if (saved.screenCount === undefined) delete process.env.COTAL_ZELLIJ_TEST_SCREEN_COUNT;
    else process.env.COTAL_ZELLIJ_TEST_SCREEN_COUNT = saved.screenCount;
    rmSync(bin, { recursive: true, force: true });
  }
}

check("no frontmatter has no placement", parseZellijPlacement("# agent\n") === undefined);
check(
  "tab with no shape defaults to stacked",
  JSON.stringify(parseZellijPlacement("---\nzellij:\n  tab: platform\n---\n")) ===
    JSON.stringify({ tab: "platform", stacked: true }),
);
check(
  "tab and explicit shape are parsed",
  JSON.stringify(parseZellijPlacement("---\nzellij:\n  tab: lane\n  direction: right\n---\n")) ===
    JSON.stringify({ tab: "lane", direction: "right" }),
);
check(
  "floating placement is parsed",
  JSON.stringify(parseZellijPlacement("---\nzellij:\n  floating: true\n---\n")) ===
    JSON.stringify({ floating: true }),
);
rejects("empty zellij block is refused", "---\nzellij:\n---\n");
rejects("unknown placement keys are refused", "---\nzellij:\n  tab: lane\n  colour: red\n---\n");
rejects("two shape keys are refused", "---\nzellij:\n  tab: lane\n  stacked: true\n  floating: true\n---\n");
rejects("empty tab names are refused", "---\nzellij:\n  tab: '  '\n---\n");
rejects("tab names starting with dash are refused", "---\nzellij:\n  tab: -lane\n---\n");
rejects("invalid direction is refused", "---\nzellij:\n  direction: left\n---\n");
check("explicit false stacked shape is preserved", JSON.stringify(parseZellijPlacement("---\nzellij:\n  stacked: false\n---\n")) === JSON.stringify({ stacked: false }));

assert.deepEqual(
  buildNewPaneArgs("42", "/work", { stacked: true }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--stacked", "--cwd", "/work"],
);
assert.deepEqual(
  buildNewPaneArgs("42", "/work", { floating: true }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--floating", "--cwd", "/work"],
);
assert.deepEqual(
  buildNewPaneArgs("42", "/work", { direction: "down" }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--direction", "down", "--cwd", "/work"],
);
assert.deepEqual(
  buildNewTabArgs("agent", "/work", ["node", "/tmp/launch.mjs"]),
  ["new-tab", "--name", "agent", "--no-focus", "--cwd", "/work", "--", "node", "/tmp/launch.mjs"],
);
checks += 4;
console.log("  ✓ pane and tab argv use focus-free CLI forms");

const temp = mkdtempSync(join(tmpdir(), "cotal-zellij-unit-"));
try {
  const secret = "unit-only-secret";
  const spec: LaunchSpec = {
    command: process.execPath,
    args: ["-e", 'process.exit(process.env.PRIVATE_VALUE ? 0 : 1)'],
    env: { PRIVATE_VALUE: secret },
  };
  const launcher = privateLauncher(spec, temp, "launcher-smoke-agent");
  if (process.platform !== "win32") check("launcher payload is owner-only", (statSync(launcher.payload).mode & 0o777) === 0o600);
  const script = join(launcher.dir, "launcher-smoke-agent");
  check("launcher script is named after the agent so zellij's fallback pane title shows it", launcher.cwd === launcher.dir && launcher.argv.at(-1)?.endsWith("launcher-smoke-agent") === true);
  check("launcher script contains no connector env values", !readFileSync(script, "utf8").includes(secret));
  const runLauncher = (preload: string[] = []) => spawnSync(process.execPath, [...preload, script], { cwd: launcher.cwd, encoding: "utf8" });
  const firstRun = runLauncher();
  check("launcher sets the agent pane title before starting the child", firstRun.stdout.startsWith("\x1b]0;launcher-smoke-agent\x07"));
  check("launcher starts child with its private env and removes the payload", firstRun.status === 0 && !existsSync(launcher.payload));
  const rerun = runLauncher();
  const rerunOutput = `${rerun.stdout}${rerun.stderr}`;
  check(
    "rerunning a consumed launcher prints the clear message and exits non-zero",
    rerun.status !== 0 && rerunOutput.includes("[cotal-zellij-launch] this pane's launch has already run; respawn the agent through cotal") && !rerunOutput.includes("MODULE_NOT_FOUND"),
  );
  const escaped = privateLauncher(spec, temp, "evil\x9d0;owned\x9c\x1b[2Jname");
  const escapedRun = spawnSync(process.execPath, [join(escaped.dir, "evil_0_owned___2Jname")], { encoding: "utf8" });
  check("launcher strips C0 and C1 controls from the pane title", escapedRun.stdout.startsWith("\x1b]0;evil0;owned[2Jname\x07"));
  if (process.platform !== "win32") {
    chmodSync(launcher.dir, 0o755);
    const marker = join(temp, "planted-command-ran");
    writeFileSync(launcher.payload, JSON.stringify({
      cwd: temp,
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
      env: process.env,
    }), { mode: 0o600 });
    const plantedRerun = runLauncher();
    const plantedOutput = `${plantedRerun.stdout}${plantedRerun.stderr}`;
    check(
      "rerunning against a recreated public directory refuses its planted payload",
      plantedRerun.status !== 0 && plantedOutput.includes("[cotal-zellij-launch] this pane's launch has already run; respawn the agent through cotal") && !existsSync(marker),
    );
    chmodSync(launcher.dir, 0o700);
    const wrongOwnerMarker = join(temp, "wrong-owner-command-ran");
    writeFileSync(launcher.payload, JSON.stringify({
      cwd: temp,
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(wrongOwnerMarker)}, "spawned")`],
      env: process.env,
    }), { mode: 0o600 });
    writeFileSync(join(temp, "wrong-owner.cjs"), `Object.defineProperty(process, "getuid", { value: () => ${process.getuid() + 1} });\n`);
    const wrongOwner = runLauncher(["-r", join(temp, "wrong-owner.cjs")]);
    const wrongOwnerOutput = `${wrongOwner.stdout}${wrongOwner.stderr}`;
    check(
      `rerunning against a recreated owner-only directory with the wrong owner refuses its payload: ${JSON.stringify(wrongOwnerOutput)}; status ${wrongOwner.status}; marker ${existsSync(wrongOwnerMarker)}`,
      wrongOwner.status !== 0 && wrongOwnerOutput.includes("[cotal-zellij-launch] this pane's launch has already run; respawn the agent through cotal") && !existsSync(wrongOwnerMarker),
    );
    rmSync(launcher.dir, { recursive: true, force: true });
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

await withFakeZellij("missing-session", (logPath, session) => {
  let state = "error";
  try {
    state = zellij.paneState(session, "terminal_99");
  } catch {
    // Assert the absent-session contract below.
  }
  let closeSucceeded = true;
  try {
    zellij.closePane(session, "terminal_99");
  } catch {
    closeSucceeded = false;
  }
  const calls = readCalls(logPath);
  check(
    "missing session reads as exited and close is a no-op without attaching a client",
    state === "exited" && closeSucceeded && calls.every((args) => args[3] !== "list-clients"),
  );
});

await withFakeZellij("no-server", (_logPath, session) => {
  check("zellij's no-sessions answer reads as exited", zellij.paneState(session, "terminal_99") === "exited");
});

await withFakeZellij("probe-error", (_logPath, session) => {
  let threw = false;
  try {
    zellij.paneState(session, "terminal_99");
  } catch {
    threw = true;
  }
  const handleStatus = (() => {
    try {
      return zellij.paneState(session, "terminal_99");
    } catch {
      return "running";
    }
  })();
  check("a failed session probe throws instead of reading as exited", threw && handleStatus === "running");
});

check(
  "an EXITED (resurrectable) session is not live",
  !zellij.hasLiveSession("lane [Created 5s ago] (EXITED - attach to resurrect)\n", "lane") &&
    zellij.hasLiveSession("lane [Created 5s ago] \n", "lane"),
);

await withFakeZellij("bad-tabs", (_logPath, session) => {
  const tmp = mkdtempSync(join(tmpdir(), "cotal-zellij-tmp-"));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  let spawnFailed = false;
  try {
    new ZellijRuntime(session).spawn("leak-agent", { command: "sleep", args: ["600"], env: { COTAL_CREDS: "secret" } }, process.cwd());
  } catch {
    spawnFailed = true;
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
  const leaked = readdirSync(tmp).filter((entry) => entry.startsWith("cotal-zellij-launch-"));
  rmSync(tmp, { recursive: true, force: true });
  check("a failed tab probe leaves no private launcher payload", spawnFailed && leaked.length === 0);
});

await withFakeZellij("partial-tab", (logPath, session) => {
  let spawnFailed = false;
  try {
    new ZellijRuntime(session).spawn("partial-agent", { command: "sleep", args: ["600"] }, process.cwd());
  } catch {
    spawnFailed = true;
  }
  const calls = readCalls(logPath);
  check(
    "failed first-pane lookup closes the created tab",
    spawnFailed && calls.some((args) => args[3] === "close-tab" && args.includes("77")),
  );
});

await withFakeZellij("confirm", async (logPath, session) => {
  process.env.COTAL_ZELLIJ_TEST_SCREEN = "Continue?";
  const handle = new ZellijRuntime(session).spawn(
    "confirm-agent",
    { command: "sleep", args: ["600"], confirm: "Continue?" },
    process.cwd(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 850));
  const calls = readCalls(logPath);
  handle.stop({ graceful: false });
  check(
    "confirm sends one Enter only after the pane displays the prompt",
    calls.filter((args) => args[3] === "write" && args.includes("13")).length === 1 &&
      calls.some((args) => args[3] === "dump-screen"),
  );
});
await withFakeZellij("confirm", async (logPath, session) => {
  process.env.COTAL_ZELLIJ_TEST_SCREEN = "Choose config?";
  const handle = new ZellijRuntime(session).spawn(
    "confirm-agent",
    {
      command: "sleep",
      args: ["600"],
      confirm: "Continue?",
      confirmBefore: [{ prompt: "Choose config?", key: "Down" }],
    },
    process.cwd(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 1_400));
  process.env.COTAL_ZELLIJ_TEST_SCREEN = "Continue?";
  await new Promise<void>((resolve) => setTimeout(resolve, 900));
  const calls = readCalls(logPath);
  handle.stop({ graceful: false });
  check(
    "confirm answers ordered choice with Down and then final prompt with Enter",
    calls.some((args) => args[3] === "write" && args.includes("27") && args.includes("91") && args.includes("66")) &&
      calls.some((args) => args[3] === "write" && args.includes("13")),
  );
});

await withFakeZellij("confirm", (logPath, session) => {
  let refused = false;
  try {
    new ZellijRuntime(session).spawn("confirm-agent", {
      command: "sleep", args: ["600"], confirmBefore: [{ prompt: "Choose config?", key: "Enter" }],
    }, process.cwd());
  } catch (error) {
    refused = error instanceof Error && error.name === "SpawnRefused";
  }
  check("startup choices without final confirm are refused before creating a tab", refused &&
    !readCalls(logPath).some((args) => args[3] === "new-tab"));
});
await withFakeZellij("slow-probe", (logPath, session) => {
  const started = Date.now();
  let failed = false;
  try {
    zellij.dumpScreen(session, "terminal_77", Date.now() + 1_000);
  } catch {
    failed = true;
  }
  const elapsed = Date.now() - started;
  check("a confirm screen read shares one deadline across its zellij calls", failed && elapsed < 1_500, { elapsed });
  check("a confirm screen read past its deadline starts no headless client",
    !readCalls(logPath).some((args) => args[0] === "attach"));
});
// script(1) runs its command through the login shell, so a stand-in client keeps the fake on PATH.
const fakeScript = (bin: string): string => {
  const path = join(bin, "script");
  writeFileSync(path, `#!/bin/sh\necho script >> "$COTAL_ZELLIJ_TEST_LOG"\nsleep 10\n`);
  chmodSync(path, 0o755);
  return path;
};
await withFakeZellij("slow-client", (logPath, session) => {
  process.env.COTAL_ZELLIJ_SCRIPT = fakeScript(dirname(logPath));
  let refusal = "";
  try {
    zellij.ensureClient(session, Date.now() + 300);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  check("a deadline that expires during the client probe starts no headless client",
    refusal.includes("deadline passed before a client could start") && !readFileSync(logPath, "utf8").includes("script"), refusal);
});
await withFakeZellij("no-client", (logPath, session) => {
  const stand = fakeScript(dirname(logPath));
  process.env.COTAL_ZELLIJ_SCRIPT = stand;
  const scriptPids = (): number[] => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      return argv.some((arg) => arg === stand) ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
  let failed = false;
  try {
    zellij.ensureClient(session, Date.now() + 400);
  } catch {
    failed = true;
  }
  const deadline = Date.now() + 2_000;
  while (scriptPids().length > 0 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  check("a bounded attach that never sees a client kills the script client it started",
    failed && readFileSync(logPath, "utf8").includes("script") && scriptPids().length === 0, scriptPids());
});
await withFakeZellij("clients-error", (logPath, session) => {
  process.env.COTAL_ZELLIJ_SCRIPT = fakeScript(dirname(logPath));
  let failed = false;
  try {
    zellij.ensureClient(session, Date.now() + 400);
  } catch {
    failed = true;
  }
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  check("a failed client listing starts no headless client",
    failed && !readFileSync(logPath, "utf8").includes("script"));
});
await withFakeZellij("clients-flaky", (logPath, session) => {
  let ok = true;
  try {
    zellij.ensureClient(session);
  } catch {
    ok = false;
  }
  check("an unbounded caller recovers from one failed client listing",
    ok && readCalls(logPath).filter((args) => args[3] === "list-clients").length >= 2);
});
// The stand-in forks a descendant like script(1) forks zellij, so group cleanup is observable.
const fakeGroupScript = (bin: string): string => {
  const path = join(bin, "script");
  writeFileSync(path, `#!/bin/sh\necho script >> "$COTAL_ZELLIJ_TEST_LOG"\nsleep 30 &\necho $! >> "$COTAL_ZELLIJ_TEST_LOG.children"\nwait\n`);
  chmodSync(path, 0o755);
  return path;
};
const alive = (pid: number): boolean => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};
const children = (logPath: string): number[] => {
  try {
    return readFileSync(`${logPath}.children`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const waitGone = (pids: number[]): number[] => {
  const until = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return pids.filter(alive);
};
const headlessCount = (logPath: string): number => readFileSync(logPath, "utf8").split("\n").filter((line) => line === "script").length;
await withFakeZellij("handoff", (logPath, session) => {
  process.env.COTAL_ZELLIJ_SCRIPT = fakeGroupScript(dirname(logPath));
  zellij.ensureClient(session, Date.now() + 2_000);
  const first = children(logPath);
  writeFileSync(`${logPath}.clients`, "1");
  zellij.ensureClient(session, Date.now() + 2_000);
  const left = waitGone(first);
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  for (const pid of left) process.kill(pid, "SIGKILL");
  check("the headless client and its descendants exit once a real client attaches",
    first.length === 1 && left.length === 0 && headlessCount(logPath) === 1, { first, left });
});
await withFakeZellij("handoff", (logPath, session) => {
  process.env.COTAL_ZELLIJ_SCRIPT = fakeGroupScript(dirname(logPath));
  zellij.ensureClient(session, Date.now() + 2_000);
  const first = children(logPath);
  // The real client leaves between the listing that saw it and the re-check after handoff.
  writeFileSync(`${logPath}.clients`, "1");
  writeFileSync(`${logPath}.clients.leave`, "");
  let ok = true;
  try {
    zellij.ensureClient(session, Date.now() + 2_000);
  } catch {
    ok = false;
  }
  const all = children(logPath);
  waitGone(first);
  const live = all.filter(alive);
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  for (const pid of live) process.kill(pid, "SIGKILL");
  check("a real client leaving during handoff leaves the session with a headless client",
    ok && headlessCount(logPath) === 2 && live.length === 1, { all, live });
});
await withFakeZellij("handoff", (logPath, session) => {
  const stand = fakeGroupScript(dirname(logPath));
  // Two survivors of earlier manager processes, unknown to this one.
  const survivors = [0, 1].map(() => {
    const child = spawn(stand, zellij.scriptAttachArgs(session), { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    return child.pid as number;
  });
  const until = Date.now() + 2_000;
  while (children(logPath).length < 2 && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  process.env.COTAL_ZELLIJ_SCRIPT = stand;
  zellij.ensureClient(session, Date.now() + 2_000);
  const all = [...survivors, ...children(logPath)];
  // One survivor group (wrapper plus its descendant) stays; the other is stopped.
  const kept = waitGone(all);
  writeFileSync(`${logPath}.clients`, "1");
  zellij.ensureClient(session, Date.now() + 2_000);
  const left = waitGone(all);
  delete process.env.COTAL_ZELLIJ_SCRIPT;
  for (const pid of left) process.kill(pid, "SIGKILL");
  check("extra headless clients from earlier managers are stopped, and the last one leaves after a real client attaches",
    kept.length === 2 && left.length === 0 && headlessCount(logPath) === 2, { kept, left });
});
await withFakeZellij("confirm", (logPath, session) => {
  let refused = false;
  try {
    new ZellijRuntime(session).spawn("confirm-agent", { command: "sleep", args: ["600"], confirm: "" }, process.cwd());
  } catch (error) {
    refused = error instanceof Error && error.name === "SpawnRefused";
  }
  check("a blank final confirm is refused before creating a tab", refused &&
    !readCalls(logPath).some((args) => args[3] === "new-tab"));
});
await withFakeZellij("unavailable", (logPath, session) => {
  let refused = false;
  try {
    new ZellijRuntime(session).spawn("worker", { command: "sleep", args: ["600"] }, process.cwd());
  } catch (error) {
    refused = error instanceof Error && error.name === "SpawnRefused";
  }
  check("unavailable Zellij fails with SpawnRefused", refused && readCalls(logPath).length === 1);
});


await withFakeZellij("dropped-pane", (logPath, session) => {
  const id = zellij.createPane(session, "77", "/work", "exec agent", { stacked: true });
  const typed = readCalls(logPath).filter((args) => args[3] === "write-chars");
  check(
    "a placed pane zellij never adds is replaced by an unplaced pane that gets the launch line",
    id === "terminal_78" && typed.length === 1 && typed[0].includes("terminal_78"),
  );
});

console.log(`ZELLIJ PACKAGE TESTS: ${checks} tests executed`);
if (failures.length > 0) throw new Error(`${failures.length} regression checks failed: ${failures.join(", ")}`);
