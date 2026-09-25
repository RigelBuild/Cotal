import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  mode: "missing-session" | "partial-tab" | "confirm" | "no-server" | "probe-error",
  run: (logPath: string, session: string) => void | Promise<void>,
): Promise<void> {
  const bin = mkdtempSync(join(tmpdir(), "cotal-zellij-fake-"));
  const executable = join(bin, "zellij");
  const logPath = join(bin, "calls.jsonl");
  const session = `ztest-fake-${process.pid}`;
  const saved = {
    PATH: process.env.PATH,
    mode: process.env.COTAL_ZELLIJ_TEST_MODE,
    session: process.env.COTAL_ZELLIJ_TEST_SESSION,
    log: process.env.COTAL_ZELLIJ_TEST_LOG,
  };
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.COTAL_ZELLIJ_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("zellij 0.45.1"); process.exit(0); }
if (args[0] === "list-sessions") {
  const mode = process.env.COTAL_ZELLIJ_TEST_MODE;
  if (mode === "no-server") { console.error("No active zellij sessions found."); process.exit(1); }
  if (mode === "probe-error") { console.error("Error occurred: timed out"); process.exit(1); }
  console.log(mode === "missing-session" ? "other-session [Created 1s ago] " : process.env.COTAL_ZELLIJ_TEST_SESSION + " [Created 1s ago] ");
  process.exit(0);
}
const action = args[3];
if (action === "list-clients") {
  console.log(process.env.COTAL_ZELLIJ_TEST_MODE === "missing-session" ? "not found" : "1");
  process.exit(0);
}
if (action === "new-tab") { console.log("77"); process.exit(0); }
if (action === "list-tabs") {
  console.log(JSON.stringify([{ tab_id: 77, name: "confirm-agent", active: true }]));
  process.exit(0);
}
if (action === "list-panes") {
  console.log(JSON.stringify(process.env.COTAL_ZELLIJ_TEST_MODE === "partial-tab" ? [] : [{
    id: 77, tab_id: 77, title: "confirm-agent", is_plugin: false, exited: false, exit_status: null
  }]));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.COTAL_ZELLIJ_TEST_MODE = mode;
  process.env.COTAL_ZELLIJ_TEST_SESSION = session;
  process.env.COTAL_ZELLIJ_TEST_LOG = logPath;
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
  buildNewPaneArgs("42", "/work", ["node", "/tmp/launch.mjs"], { stacked: true }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--stacked", "--cwd", "/work", "--", "node", "/tmp/launch.mjs"],
);
assert.deepEqual(
  buildNewPaneArgs("42", "/work", ["node", "/tmp/launch.mjs"], { floating: true }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--floating", "--cwd", "/work", "--", "node", "/tmp/launch.mjs"],
);
assert.deepEqual(
  buildNewPaneArgs("42", "/work", ["node", "/tmp/launch.mjs"], { direction: "down" }),
  ["new-pane", "--tab-id", "42", "--no-focus", "--direction", "down", "--cwd", "/work", "--", "node", "/tmp/launch.mjs"],
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
  const spec: LaunchSpec = { command: "sleep", args: ["600"], env: { PRIVATE_VALUE: secret } };
  const launcher = privateLauncher(spec, temp);
  check("launcher script is owner-only", (statSync(launcher.script).mode & 0o777) === 0o600);
  check("launcher argv contains no connector env values", !launcher.argv.includes(secret));
  check("launcher stores command and env outside pane argv", readFileSync(launcher.script, "utf8").includes(secret));
  rmSync(launcher.dir, { recursive: true, force: true });
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
  const handle = new ZellijRuntime(session).spawn(
    "confirm-agent",
    { command: "sleep", args: ["600"], confirm: "Continue?" },
    process.cwd(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5_250));
  const writes = readCalls(logPath).filter((args) => args[3] === "write");
  handle.stop({ graceful: false });
  check(
    "confirm sends five Enter presses to the spawned pane",
    writes.length === 5 && writes.every((args) => args.slice(4).join(" ") === "-p terminal_77 13"),
  );
});

console.log(`ZELLIJ PACKAGE TESTS: ${checks} tests executed`);
if (failures.length > 0) throw new Error(`${failures.length} regression checks failed: ${failures.join(", ")}`);
