import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ZellijRuntime } from "./src/runtime.ts";
import * as zellij from "./src/driver.ts";

const session = `ztest-${process.pid}-${Date.now()}`;
const temp = mkdtempSync(join(tmpdir(), "cotal-zellij-live-"));
const runtime = new ZellijRuntime(session);
let created = false;

try {
  zellij.ensureSession(session);
  created = true;
  zellij.ensureClient(session);
  const headlessTabs = JSON.parse(execFileSync("zellij", ["--session", session, "action", "list-tabs", "--json"], { encoding: "utf8" })) as Array<{
    display_area_columns?: number;
    display_area_rows?: number;
  }>;
  assert.ok(headlessTabs.some((tab) => (tab.display_area_columns ?? 0) >= 1000 && (tab.display_area_rows ?? 0) >= 500));
  console.log("  ✓ headless client advertises 1000x500 terminal size");

  zellij.createEmptyTab(session, "focus-sentinel", process.cwd());
  const focusedBefore = zellij.listTabs(session).find((tab) => tab.active)?.tab_id;
  const laneFile = join(temp, "lane.md");
  const defaultFile = join(temp, "default.md");
  const badFile = join(temp, "bad.md");
  writeFileSync(laneFile, "---\nzellij:\n  tab: lane\n  stacked: true\n---\n");
  writeFileSync(defaultFile, "---\ntitle: Default\n---\n");
  writeFileSync(badFile, "---\nzellij:\n  tab: -invalid\n---\n");

  const launch = { command: "sleep", args: ["600"], env: { COTAL_AGENT_FILE: laneFile } };
  const laneA = runtime.spawn("lane-a", launch, process.cwd());
  const laneB = runtime.spawn("lane-b", launch, process.cwd());
  const defaults = runtime.spawn("default-agent", { ...launch, env: { COTAL_AGENT_FILE: defaultFile } }, process.cwd());
  const tabs = zellij.listTabs(session);
  const laneTab = tabs.find((tab) => tab.name === "lane");
  const defaultTab = tabs.find((tab) => tab.name === "default-agent");
  assert.ok(laneTab && defaultTab);
  const allPanes = zellij.listPanes(session);
  const lanePanes = allPanes.filter((pane) => pane.tab_id === laneTab.tab_id && !pane.is_plugin);
  assert.equal(lanePanes.length, 2);
  console.log("  ✓ two lane agents share one named stacked tab");
  const defaultPanes = allPanes.filter((pane) => pane.tab_id === defaultTab.tab_id && !pane.is_plugin);
  assert.equal(defaultPanes.length, 1);
  assert.notEqual(defaultTab.tab_id, laneTab.tab_id);
  console.log("  ✓ agent without a zellij block gets its own named tab");
  assert.equal(tabs.find((tab) => tab.active)?.tab_id, focusedBefore);
  console.log("  ✓ tab focus is unchanged across spawns");

  const paneCount = allPanes.length;
  assert.throws(() => runtime.spawn("bad-agent", {
    command: "sleep",
    args: ["600"],
    env: { COTAL_AGENT_FILE: badFile },
  }, process.cwd()));
  assert.equal(zellij.listPanes(session).length, paneCount);
  console.log("  ✓ bad placement spawns no pane");

  laneA.stop({ graceful: false });
  await laneA.waitForExit?.();
  assert.equal(laneA.status(), "exited");
  console.log("  ✓ stop closes its pane and waitForExit resolves");
  assert.equal(laneB.status(), "running");
  console.log("  ✓ stopping one pane leaves its lane mate running");
  laneB.stop({ graceful: false });
  defaults.stop({ graceful: false });
  await Promise.all([laneB.waitForExit?.(), defaults.waitForExit?.()]);
} finally {
  if (created) {
    try {
      const result = spawnSync("zellij", ["kill-session", session], { stdio: "ignore" });
      if (result.error) throw result.error;
    } catch {
      /* the session may have exited during a failed smoke */
    }
    try {
      const result = spawnSync("zellij", ["delete-session", session], { stdio: "ignore" });
      if (result.error) throw result.error;
    } catch {
      /* the session may already be deleted */
    }
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log("ZELLIJ LIVE SMOKE: all scenarios passed");
