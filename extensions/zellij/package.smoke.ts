import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "@cotal-ai/core";
import { buildNewPaneArgs, buildNewTabArgs } from "./src/driver.js";
import { parseZellijPlacement } from "./src/placement.js";
import { privateLauncher } from "./src/runtime.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
}

function rejects(name: string, raw: string): void {
  assert.throws(() => parseZellijPlacement(raw), undefined, name);
  checks++;
  console.log(`  ✓ ${name}`);
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
  const mode = statSync(launcher.script).mode & 0o777;
  check("launcher script is owner-only", mode === 0o600);
  check("launcher argv contains no connector env values", !launcher.argv.includes(secret));
  check("launcher stores command and env outside pane argv", readFileSync(launcher.script, "utf8").includes(secret));
  rmSync(launcher.dir, { recursive: true, force: true });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`ZELLIJ PACKAGE TESTS: ${checks} tests executed`);
