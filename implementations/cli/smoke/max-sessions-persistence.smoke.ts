import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-max-sessions-"));
process.env.COTAL_HOME = home;

const { recordMesh, findMesh, parsePositiveIntegerFlag, recordManagerSeatMintCap, readManagerSeatMintCap } = await import("@cotal-ai/workspace");
const { maxSessionsFor } = await import("../src/commands/up.js");
const { liveManagerWouldApplyMaxSessions, maxSessionsFromSuperviseArgv } = await import("../src/lib/manager-proc.js");

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const base = { server: "nats://127.0.0.1:4225", root: home, mode: "auth" as const, ts: new Date().toISOString() };

try {
  check("absent --max-sessions stays undefined", parsePositiveIntegerFlag("--max-sessions", undefined) === undefined);
  check("a positive integer parses", parsePositiveIntegerFlag("--max-sessions", "256") === 256);
  let bad = false;
  try { parsePositiveIntegerFlag("--max-sessions", "0"); } catch (e) { bad = e instanceof Error && e.message.includes("--max-sessions"); }
  check("zero is refused by name", bad);
  bad = false;
  try { parsePositiveIntegerFlag("--max-sessions", "nope"); } catch (e) { bad = e instanceof Error && e.message.includes("--max-sessions"); }
  check("a non-integer is refused by name", bad);

  recordMesh({ ...base, space: "sized", maxSessions: 256 });
  check("a sized mesh round-trips its ceiling", findMesh("sized")?.maxSessions === 256);
  check("a later launch reads the recorded ceiling", maxSessionsFor("sized") === 256);
  check("an explicit ceiling on this invocation wins", maxSessionsFor("sized", 128) === 128);
  recordMesh({ ...base, space: "defaulted", server: "nats://127.0.0.1:4226" });
  check("a mesh that never asked records no ceiling", findMesh("defaulted")?.maxSessions === undefined);
  check("an absent ceiling stays undefined", maxSessionsFor("defaulted") === undefined);
  check("an unknown space resolves to undefined", maxSessionsFor("no-such-space") === undefined);

  recordManagerSeatMintCap({ root: home, space: "minted" }, 11);
  recordMesh({ ...base, space: "minted" });
  check("manager seat mint cap is saved in the protected per-space record", readManagerSeatMintCap({ root: home, space: "minted" }) === 11);
  check("a later launch without the flag keeps the saved cap", readManagerSeatMintCap({ root: home, space: "minted" }) === 11);
  check("the protected cap record is unchanged by a launch that only reads it", readManagerSeatMintCap({ root: home, space: "minted" }) === 11);
  check("an unknown space keeps the manager default unset", readManagerSeatMintCap({ root: home, space: "missing" }) === undefined);

  const liveBare = "/usr/bin/node /opt/cotal/bin/dist/cotal.js supervise --space sized --server nats://127.0.0.1:35715";
  const liveSized = `${liveBare} --max-sessions 3`;
  check("absent --max-sessions is not a recorded default", maxSessionsFromSuperviseArgv(liveBare) === undefined);
  check("a live supervisor argv reports its applied ceiling", maxSessionsFromSuperviseArgv(liveSized) === 3);
  check("equals-form argv reports the applied ceiling", maxSessionsFromSuperviseArgv(`${liveBare} --max-sessions=3`) === 3);
  check("a matching refresh may proceed", liveManagerWouldApplyMaxSessions(liveSized, 3) === true);
  check("an unapplied refresh must be refused", liveManagerWouldApplyMaxSessions(liveBare, 1) === false);
  check("an unreadable command line cannot prove a match", liveManagerWouldApplyMaxSessions(undefined, 1) === false);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ max-sessions persistence smoke passed");
process.exit(failures ? 1 : 0);
