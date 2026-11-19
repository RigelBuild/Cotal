/**
 * Placement wiring: the production reconciler authenticator, the reconciler principal config (the
 * `--reconciler-principal` flag and the manifest's `reconcilerPrincipal` field), and placement staying
 * unconfigured while only the authenticator is set. Each case prints one ✓ or ✗ line; the process
 * exits non-zero when any case fails.
 */
import assert from "node:assert/strict";
import { EpEnvelopeError, type EpServeContext } from "@cotal-ai/core";
import * as enrollment from "../src/placement-enrollment.js";
import * as service from "../src/service.js";
import { createPlacementDoorHandlers } from "../src/placement-participant-door.js";

const OWNER = `u_${"a".repeat(26)}`;
const OTHER_OWNER = `u_${"b".repeat(26)}`;
const RECONCILER_KEY = `${OWNER}.reconciler`;
const OPERATION = "auth.verify-placement-enrollment";
const DIGEST = `sha256:${"0".repeat(64)}`;

const ctx = (caller: { owner: string; actor: string; uid: string }, args: Record<string, unknown>): EpServeContext =>
  ({ subject: { caller }, request: { args } }) as unknown as EpServeContext;

let failed = 0;
async function check(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- A2: the production authenticator admits exactly the configured owner.actor key ---------------
await check("A2 admits the exact reconciler owner.actor key", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await auth.authenticateService({ transportPrincipal: RECONCILER_KEY, operation: OPERATION, requestDigest: DIGEST }), { principal: "reconciler" });
});

await check("A2 refuses another owner's reconciler actor", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await auth.authenticateService({ transportPrincipal: `${OTHER_OWNER}.reconciler`, operation: OPERATION, requestDigest: DIGEST }), { principal: "unauthorized" });
});

await check("A2 refuses an actor-only name and a suffix match", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  for (const transportPrincipal of ["reconciler", `${OWNER}x.reconciler`, `x${RECONCILER_KEY}`]) {
    assert.deepEqual(await auth.authenticateService({ transportPrincipal, operation: OPERATION, requestDigest: DIGEST }), { principal: "unauthorized" }, transportPrincipal);
  }
});

// ---- A4: the reconciler principal reaches the lane options; placement stays unconfigured -----------
await check("A4 manifest reconcilerPrincipal reaches the parsed lane settings", () => {
  const text = JSON.stringify({ version: 2, spaces: [{ space: "main", reconcilerPrincipal: RECONCILER_KEY }, { space: "side" }] });
  const manifest = service.parseAuthHostManifest(text);
  assert.equal(manifest.settings.get("main")?.reconcilerPrincipal, RECONCILER_KEY);
  assert.equal(manifest.settings.get("side")?.reconcilerPrincipal, undefined);
});

await check("A4 --reconciler-principal reaches the single-space options", () => {
  const parsed = service.authServiceConfiguration({
    values: { space: "main", server: "nats://127.0.0.1:1", "reconciler-principal": RECONCILER_KEY },
    positionals: [], raw: [], positionalIndices: [],
  } as unknown as Parameters<typeof service.authServiceConfiguration>[0]);
  assert.equal(parsed.reconcilerPrincipal, RECONCILER_KEY);
});

await check("A4 only the authenticator leaves placement unconfigured", () => {
  const configured = service.placementPortsConfigured({ placementAuthenticator: enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY) });
  assert.equal(configured, false);
});

await check("A4 with only the authenticator, placement commands answer unimplemented", async () => {
  const configured = service.placementPortsConfigured({ placementAuthenticator: enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY) });
  const handlers = createPlacementDoorHandlers({ configured, port: () => undefined });
  const reconciler = { owner: OWNER, actor: "reconciler", uid: "reconcileruid" };
  const runs: [string, () => Promise<unknown>][] = [
    ["verify", () => handlers.verifyPlacementEnrollment(ctx(reconciler, {}))],
    ["status", () => handlers.enrollmentEffectStatus(ctx(reconciler, {}))],
    ["close", () => handlers.closeEnrollmentEffect(ctx(reconciler, {}))],
    ["retire", () => handlers.retirePlacementEnrollment(ctx(reconciler, {}))],
  ];
  for (const [name, run] of runs) {
    await assert.rejects(run(), (e: unknown) => e instanceof EpEnvelopeError && e.code === "unimplemented", name);
  }
});

console.log(failed === 0 ? "placement wiring smoke passed" : `placement wiring smoke FAILED (${failed} failed)`);
if (failed > 0) process.exitCode = 1;
