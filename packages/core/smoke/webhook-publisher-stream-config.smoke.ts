/**
 * The DM and TASK duplicate windows must be at least 5 s, so a publish retried inside the JetStream
 * client's 5 s default timeout is deduplicated instead of stored twice. External publishers (Saiph)
 * must set a publish timeout no longer than that window. Hermetic: reads the canonical config only.
 *
 * Run: pnpm smoke:webhook-publisher-stream-config
 */
import { canonicalBackupStreamConfig, dmStream, taskStream } from "../src/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const space = "webhookstreamcfg";
const NS_PER_MS = 1_000_000;
const MIN_DUPLICATE_WINDOW_MS = 5_000;

console.log("the DM and TASK duplicate windows:");
for (const stream of [dmStream(space), taskStream(space)]) {
  const windowMs = (canonicalBackupStreamConfig(space, stream).duplicate_window ?? 0) / NS_PER_MS;
  check(`${stream} duplicate_window (${windowMs} ms) is at least 5 s`, windowMs >= MIN_DUPLICATE_WINDOW_MS, { windowMs });
}

console.log(`\nwebhook-publisher-stream-config: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail });
process.exit(fail === 0 ? 0 : 1);
