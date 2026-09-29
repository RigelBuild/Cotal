import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ZellijRuntime } from "./src/runtime.ts";
import * as zellij from "./src/driver.ts";

const session = `ztest-${process.pid}-${Date.now()}`;
console.log(`ZELLIJ TEST SESSION: ${session}`);
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

  const titleFile = join(temp, "title.md");
  writeFileSync(titleFile, "---\nzellij:\n  tab: launch-title-lane\n  stacked: true\n---\n");
  const titleLaunch = {
    command: process.execPath,
    args: ["-e", 'process.stdout.write("\\x1b]0;launcher-title-smoke\\x07"); process.exit(0);'],
    env: { COTAL_AGENT_FILE: titleFile },
  };
  runtime.spawn("title-first", titleLaunch, process.cwd());
  runtime.spawn("title-second", titleLaunch, process.cwd());
  const titleTab = zellij.listTabs(session).find((tab) => tab.name === "launch-title-lane");
  assert.ok(titleTab);
  let titledPane = zellij.listPanes(session).find(
    (pane) => pane.tab_id === titleTab.tab_id && !pane.is_plugin && pane.title === "launcher-title-smoke",
  );
  for (let attempt = 0; !titledPane && attempt < 30; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    titledPane = zellij.listPanes(session).find(
      (pane) => pane.tab_id === titleTab.tab_id && !pane.is_plugin && pane.title === "launcher-title-smoke",
    );
  }
  assert.ok(titledPane, "new pane accepts the program's OSC title");
  console.log("  ✓ a pane created without --name displays the program's OSC title");
  for (let attempt = 0; zellij.paneState(session, titledPane.id) !== "exited" && attempt < 30; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(zellij.paneState(session, titledPane.id), "exited");
  execFileSync("zellij", ["--session", session, "action", "send-keys", "--pane-id", titledPane.id, "Enter"]);
  let rerunOutput = "";
  for (let attempt = 0; !rerunOutput.includes("this pane's launch has already run; respawn the agent through cotal") && attempt < 30; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    rerunOutput = execFileSync("zellij", ["--session", session, "action", "dump-screen", "--pane-id", titledPane.id], { encoding: "utf8" });
  }
  assert.ok(rerunOutput.includes("[cotal-zellij-launch] this pane's launch has already run; respawn the agent through cotal"));
  console.log("  ✓ Enter on the exited pane prints the clear rerun message");

  const paneCount = zellij.listPanes(session).length;
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
