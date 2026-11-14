import { existsSync, mkdtempSync, symlinkSync, tmpdir, join, boot, check, freshCfg, seedDir, listNames, track, finishScenario } from "./harness.js";

try {
  // ── a seed that fails is reported with its reason; the next start retries it, with no --repair ──
  {
    const cfg = track(freshCfg());
    // `node` and nothing else on PATH, so the seed child's `npm install` cannot start.
    const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-no-npm-")));
    symlinkSync(process.execPath, join(bin, "node"));
    const noNpm = { PATH: bin };
    const cursor = join(seedDir(cfg), "reconcile.cursor.json");
    const first = boot(cfg, noNpm);
    check("failed seed: the boot fails", first.status !== 0, first.stderr);
    check("failed seed: the reason follows the colon on the failure line",
      /failed to seed connector "claude" from \S+: @cotal-ai\/connector-claude-code npm install failed: npm is not on PATH/.test(first.stderr) && !first.stderr.includes("\\u000a") && !first.stderr.includes("spawn npm ENOENT"), first.stderr);
    const next = boot(cfg, noNpm);
    check("failed seed: the next boot retries the seed under the locks, with no refusal and no interruption",
      next.status !== 0 && /recovering from a failed seed \(package "claude"\)/.test(next.stderr) && !/a previous connector seed (failed|was interrupted)/.test(next.stderr), next.stderr);
    check("failed seed: the retry fails again with its own reason and keeps the cursor",
      /failed to seed connector "claude" from \S+: @cotal-ai\/connector-claude-code npm install failed/.test(next.stderr) && existsSync(cursor), next.stderr);
    const restored = boot(cfg);
    check("failed seed: with npm back, the next start seeds the failed connector without --repair",
      restored.status === 0 && /recovering from a failed seed \(package "claude"\)/.test(restored.stderr), restored.stderr);
    check("failed seed: the automatic retry installed the failed connector", listNames(cfg).includes("claude"));
    check("failed seed: the cursor is cleared after the verified install", !existsSync(cursor));
  }
} finally {
  finishScenario();
}
