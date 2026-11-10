import { lstatSync } from "node:fs";
import { chmodSync, existsSync, mkdirSync, readdirSync, join, check, cotal, freshCfg, seedDir, readJson, writeJson, listNames, track, finishScenario } from "./harness.js";

const cleanupDirectories: string[] = [];
const freshStoreCfg = (): string => {
  const cfg = track(freshCfg());
  cleanupDirectories.push(cfg);
  return cfg;
};

function setTreePermissions(path: string, fileMode: number, dirMode: number): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) setTreePermissions(join(path, name), fileMode, dirMode);
    chmodSync(path, dirMode);
  } else {
    chmodSync(path, fileMode);
  }
}

function ownerWritableTree(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return true;
  if ((stat.mode & 0o200) === 0) return false;
  return !stat.isDirectory() || readdirSync(path).every((name) => ownerWritableTree(join(path, name)));
}


try {
  // A store seeded from a read-only package-manager source must remain owner-writable.
  if (process.platform !== "win32") {
    {
      const cfg = freshStoreCfg();
      listNames(cfg);
      const generation = readJson(join(seedDir(cfg), "stamp.json")).generation;
      const payload = join(seedDir(cfg), "store", generation, "opencode");
      setTreePermissions(payload, 0o444, 0o555);
      const forced = cotal(cfg, ["ext", "seed", "--force"]);
      const rebuilt = join(seedDir(cfg), "store", generation, "opencode");
      check("seed store #27: forced repair replaces a read-only payload", forced.status === 0 && existsSync(join(rebuilt, "package.json")), forced.stderr);
      check("seed store #27: every copied payload path is owner-writable", ownerWritableTree(rebuilt), rebuilt);
    }

    {
      const cfg = freshStoreCfg();
      listNames(cfg);
      const storeRoot = join(seedDir(cfg), "store");
      const stale = join(storeRoot, "0.0.1-stale", "opencode");
      mkdirSync(stale, { recursive: true });
      writeJson(join(stale, "package.json"), { name: "@cotal-ai/connector-opencode", version: "0.0.1-stale" });
      setTreePermissions(stale, 0o444, 0o555);
      const forced = cotal(cfg, ["ext", "seed", "--force"]);
      check("seed store #27: GC removes a read-only stale generation", forced.status === 0 && !existsSync(join(storeRoot, "0.0.1-stale")), forced.stderr);
    }
  }

  // ── 8c. the store's DESTRUCTIVE step is announced too (#593) ─────────────────────────────────────
  {
    const cfg = freshStoreCfg();
    listNames(cfg); // seed once, so a live generation exists beside the one we plant
    const sd = seedDir(cfg);
    const storeRoot = join(sd, "store");
    // Plant an unreferenced older generation: no manifest entry installs from it, which is exactly the
    // condition gcSeedStore removes on. It is a directory with a payload in it, not an empty shell, so
    // the removal is a real recursive delete of operator-global bytes.
    const stale = join(storeRoot, "0.0.1-stale", "opencode");
    mkdirSync(stale, { recursive: true });
    writeJson(join(stale, "package.json"), { name: "@cotal-ai/connector-opencode", version: "0.0.1-stale" });
    const forced = cotal(cfg, ["ext", "seed", "--force"]);
    check("gc: the unreferenced generation is actually removed", forced.status === 0 && !existsSync(join(storeRoot, "0.0.1-stale")), forced.stderr);
    check("provenance: the machine-wide seed-store DELETE is announced with its path (not silent)",
      forced.stderr.includes("removed operator-global seed store generation (0.0.1-stale)") &&
        forced.stderr.includes(join(storeRoot, "0.0.1-stale")),
      forced.stderr);
  }
} finally {
  for (const dir of cleanupDirectories) setTreePermissions(dir, 0o600, 0o700);
  finishScenario();
}
