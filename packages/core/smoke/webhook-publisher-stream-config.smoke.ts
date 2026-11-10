/**
 * The DM and TASK streams' duplicate window must cover the JetStream publish timeout, so a publish
 * retried inside the timeout is deduplicated instead of stored twice. Hermetic: it reads the
 * canonical stream config only, so no broker is needed.
 *
 * Run: pnpm smoke:webhook-publisher-stream-config
 */
import { canonicalBackupStreamConfig, dmStream, JETSTREAM_PUBLISH_TIMEOUT_MS, taskStream } from "../src/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const space = "webhookstreamcfg";
const NS_PER_MS = 1_000_000;

console.log("the DM and TASK duplicate windows against the publish timeout:");
check("the publish timeout is the JetStream client default, 5000 ms", JETSTREAM_PUBLISH_TIMEOUT_MS === 5_000, JETSTREAM_PUBLISH_TIMEOUT_MS);
for (const stream of [dmStream(space), taskStream(space)]) {
  const windowMs = (canonicalBackupStreamConfig(space, stream).duplicate_window ?? 0) / NS_PER_MS;
  check(`${stream} duplicate_window (${windowMs} ms) is at least the publish timeout`, windowMs >= JETSTREAM_PUBLISH_TIMEOUT_MS, { windowMs });
}

console.log(`\nwebhook-publisher-stream-config: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail });
process.exit(fail === 0 ? 0 : 1);
