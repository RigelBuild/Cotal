import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { resolveNatsServer } from "../src/lib/nats-bin.js";
import { pickFreePort } from "../../manager/smoke/_free-port.js";
import { runCli } from "../src/command.js";
import "../src/index.js";

const home = mkdtempSync(join(tmpdir(), "cotal-continue-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-continue-root-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";
const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}continue-js-`));
const { bin } = await resolveNatsServer();
const broker = spawnProcess(bin, ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const server = `nats://127.0.0.1:${port}`;
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const persona = join(root, ".cotal", "agents", "probe.md");
writeFileSync(persona, "---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
recordMesh({ space: "continue", server, root, mode: "open", ts: new Date().toISOString() } as never);
let captured: LaunchOpts | undefined;
const continued: Connector = {
  kind: "connector", name: "continue-probe", requires: [], supportsSessionContinuation: true,
  buildLaunch: (opts: LaunchOpts): LaunchSpec => { captured = opts; throw new Error("__probe_stop__"); },
};
const unsupported: Connector = {
  kind: "connector", name: "unsupported-probe", requires: [],
  buildLaunch: (): LaunchSpec => ({ command: "/bin/true", args: [], env: {} }),
};
registry.register(continued);
registry.register(unsupported);
let pass = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) { pass++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? `: ${detail.slice(0, 300)}` : ""}`); }
}
async function run(extra: string[]): Promise<string> {
  let stderr = "";
  const oldError = console.error;
  const oldWrite = process.stderr.write.bind(process.stderr);
  const oldExit = process.exit;
  console.error = (...args: unknown[]) => { stderr += `${args.map(String).join(" ")}\n`; };
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => { throw new Error(`__exit__${code}`); }) as never;
  try { await runCli(registry, ["spawn", "--no-events", "--config", persona, "--server", server, "--space", "continue", ...extra]); }
  catch { /* expected command completion or refusal */ }
  finally { console.error = oldError; process.stderr.write = oldWrite; process.exit = oldExit; }
  return stderr;
}
try {
  process.chdir(root);
  const launched = await run(["--agent", "continue-probe", "--continue", "session-123"]);
  check("continue forwards exact session id", captured?.continueSession === "session-123" && !launched.includes("usage: cotal spawn"), JSON.stringify({ captured: captured?.continueSession, launched: launched.slice(0, 300) }));
  const both = await run(["--continue", "session-123", "--resume", "source"]);
  check("continue and resume are refused", both.includes("mutually exclusive"));
  const refused = await run(["--agent", "unsupported-probe", "--continue", "session-123"]);
  check("unsupported connector continuation is refused", refused.includes("does not support continuing"));
} finally {
  emitSentinel({ passed: pass, failed });
  broker.kill();
  // The CLI leaves mesh connections open after the probe throws; exit rather than wait on them.
  process.exit(failed === 0 && pass === 3 ? 0 : 1);
}
