import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { closureFromConfig } from "./verify-publish-closure.mjs";
import { releaseManifests, stageReleasePlan, STAGING_TAG } from "./stage-release-plan.mjs";

// This fork does not publish to npm and releases through rigel-release.yml.
const root = join(import.meta.dirname, "..");
const entry = (name) => ({ kind: "publish", name, version: "1.2.3", access: "public", tag: "latest" });
const manifests = [{ name: "core", version: "1.2.3" }, { name: "adapter", version: "1.2.3", peerDependencies: { core: "*" } }, { name: "cotal-ai", version: "1.2.3", dependencies: { core: "*" } }];
const fixed = manifests.map((pkg) => pkg.name);
const plan = () => ({ version: 1, plan: [[entry("core")], [entry("adapter"), entry("cotal-ai")]] });

test("staging preserves supported plan fields and derives dependency order with binary last", () => {
  const source = plan();
  const result = stageReleasePlan(source, fixed, manifests);
  assert.deepEqual(result.specs, ["core@1.2.3", "adapter@1.2.3", "cotal-ai@1.2.3"]);
  assert(result.document.plan.flat().every((release) => release.tag === STAGING_TAG));
  assert(source.plan.flat().every((release) => release.tag === "latest"));
  for (const group of result.document.plan) for (const release of group) release.tarball = { path: `packages/${release.name}.tgz`, integrity: "sha256-synthetic" };
  assert.deepEqual(stageReleasePlan(result.document, fixed, manifests, { packed: true }).specs, result.specs);
});

test("incomplete, duplicate, foreign, mixed, latest-packed and disordered plans refuse", () => {
  const cases = [
    (p) => p.plan.pop(),
    (p) => p.plan[1].push(entry("core")),
    (p) => { p.plan[0][0].name = "foreign"; },
    (p) => { p.plan[0][0].version = "1.2.2"; },
    (p) => { p.plan[0][0].kind = "tag-only"; },
    (p) => { p.plan[0][0].tag = "beta"; },
    (p) => { p.plan.reverse(); },
    (p) => { p.version = 2; },
  ];
  for (const change of cases) { const candidate = plan(); change(candidate); assert.throws(() => stageReleasePlan(candidate, fixed, manifests)); }
  assert.throws(() => stageReleasePlan(plan(), fixed, manifests, { packed: true }), /tag/);
  assert.throws(() => stageReleasePlan(plan(), fixed, [...manifests, { name: "outside", version: "1.2.3" }]), /workspace/);
});

test("real repository closure stages dependency-ordered packages with the binary last", () => {
  const packages = releaseManifests(root);
  const names = closureFromConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  const remaining = new Set(names), groups = [];
  while (remaining.size) {
    const ready = packages.filter((pkg) => remaining.has(pkg.name) && Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).every((dependency) => !remaining.has(dependency)));
    assert(ready.length > 0);
    groups.push(ready.map((pkg) => ({ ...entry(pkg.name), version: pkg.version })));
    for (const pkg of ready) remaining.delete(pkg.name);
  }
  const result = stageReleasePlan({ version: 1, plan: groups }, names, packages);
  assert.equal(result.specs.length, names.length);
  assert.equal(result.specs.at(-1), `cotal-ai@${packages.find((pkg) => pkg.name === "cotal-ai").version}`);
});

