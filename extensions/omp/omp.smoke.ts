import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "@cotal-ai/core";
import { ompConnector } from "./src/connector.js";

const launch = ompConnector.buildLaunch;
assert.ok(launch);
const base = {
  space: "main", name: "worker", creds: {}, servers: [], eventsRequired: false,
  events: false, envAllow: [],
};
const fresh = launch({ ...base });
const sessionIndex = fresh.args.indexOf("--session-id");
assert.ok(sessionIndex >= 0);
const freshId = fresh.args[sessionIndex + 1];
assert.ok(freshId);
assert.equal(fresh.env.COTAL_PI_EXPECTED_SESSION, freshId);
assert.equal(fresh.env.COTAL_PI_FRESH_SESSION, "1");
assert.equal(fresh.command, "omp");
assert.equal(fresh.args[0], "--extension");
assert.ok(existsSync(fresh.args[1]!), `bundle missing: ${fresh.args[1]}`);

const resumed = launch({ ...base, resume: "source-id" });
assert.deepEqual(resumed.args.slice(resumed.args.indexOf("--fork"), resumed.args.indexOf("--fork") + 2), ["--fork", "source-id"]);
assert.equal(resumed.env.COTAL_PI_EXPECTED_SESSION, undefined);
const continued = launch({ ...base, continueSession: "existing-id" });
assert.deepEqual(continued.args.slice(continued.args.indexOf("--session-id")), ["--session-id", "existing-id"]);

const personaPath = join(mkdtempSync(join(tmpdir(), "omp-smoke-")), "worker.md");
writeFileSync(personaPath, "---\nname: worker\n---\nDo the work.\n");
const configured = launch({ ...base, configPath: personaPath, model: "model-x", launchOptions: { config: "/tmp/omp.yaml" }, prompt: "do work" });
assert.ok(configured.args.includes("--config") && configured.args[configured.args.indexOf("--config") + 1] === "/tmp/omp.yaml");
assert.ok(configured.args.includes("--append-system-prompt"));
assert.deepEqual(configured.args.slice(-1), ["do work"]);
assert.ok(configured.args.includes("--model") && configured.args[configured.args.indexOf("--model") + 1] === "model-x");
assert.equal(launch({ ...base, resolvedBinaries: { omp: "/bin/omp" } }).command, "/bin/omp");
assert.throws(() => launch({ ...base, launchOptions: { other: true } }), /unknown launch option.*other/i);
const reapplied = launch({ ...base, resume: "source-id", launchOptions: { config: "/tmp/omp.yaml", reapplyConfig: "true" } });
assert.ok(reapplied.args.includes("--reapply-config"), "a resumed session re-applies the overlay's model and thinking level");
assert.ok(launch({ ...base, continueSession: "existing-id", launchOptions: { reapplyConfig: "true" } }).args.includes("--reapply-config"));
assert.equal(launch({ ...base, launchOptions: { reapplyConfig: "true" } }).args.includes("--reapply-config"), false, "a fresh session has nothing to re-apply over");
assert.equal(launch({ ...base, resume: "source-id", launchOptions: { reapplyConfig: "false" } }).args.includes("--reapply-config"), false);
assert.ok(launch({ ...base, resume: "source-id", launchOptions: { reapplyConfig: true } }).args.includes("--reapply-config"), "a persona YAML boolean is accepted");
assert.throws(() => launch({ ...base, resume: "source-id", launchOptions: { reapplyConfig: "yes" } }), /reapplyConfig must be true or false/);

await import("./src/index.js");
assert.ok(registry.has("connector", "omp"));
assert.equal(registry.has("connector", "pi"), false);
console.log("omp smoke: buildLaunch, launchOptions, and registration passed");
