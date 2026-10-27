import { existsSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 3b. a pending marker whose parent died resumes unattended ─────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
    // A reconcile killed while spawning its seed child leaves the cursor and a pending marker naming a
    // dead parent (2147483646 is never a live reconcile parent).
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "x", package: "hermes", phase: "add" });
    writeJson(join(seedDir(cfg), "reconcile.child.json"), { state: "pending", parentPid: 2147483646, nonce: "x", ts: 1 });
    const auto = cotal(cfg, ["ext", "list"]);
    check("dead-parent marker: the next command repairs and succeeds", auto.status === 0, auto.stderr);
    check("dead-parent marker: the interrupted connector is reinstalled", listNames(cfg).includes("hermes"));
    check("dead-parent marker: marker and cursor are cleared",
      !existsSync(join(seedDir(cfg), "reconcile.child.json")) && !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
  }
  // ── 3c. a corrupt marker still fails loud ─────────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "x", package: "hermes", phase: "add" });
    writeJson(join(seedDir(cfg), "reconcile.child.json"), { state: "unknown" });
    const auto = cotal(cfg, ["ext", "list"]);
    check("corrupt marker: auto boot fails loud (mid-flight, manual clear)", auto.status !== 0 && /mid-flight/i.test(auto.stderr), auto.stderr);
  }
} finally {
  finishScenario();
}
