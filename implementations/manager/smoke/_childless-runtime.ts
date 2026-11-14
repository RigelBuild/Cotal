import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LaunchSpec, Runtime, RuntimeReference } from "@cotal-ai/core";
import { processStartToken } from "@cotal-ai/seat";
import { pidfdExited, pidfdOpen } from "../../../packages/seat/dist/peercred.js";

/** Fixture-only closure for an allowlisted program that never launches child processes. This
 * proves nothing about arbitrary connectors or detached tools. It never sends a signal. */
export function childlessRuntime(runtime: Runtime, root: string, accepts: (spec: LaunchSpec) => boolean): Runtime {
  assert.equal(process.platform, "linux", "the fixture's birth reader requires Linux");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Match custody's start-token parser, including `/proc/<pid>/stat` command names with spaces or `) `.
  const birth = processStartToken;
  const path = (ref: RuntimeReference) => {
    assert.equal(ref.kind, runtime.kind);
    assert.match(ref.id, /^[a-f0-9-]{36}$/);
    return join(root, `${ref.id}.json`);
  };
  const reapWork = async (ref: RuntimeReference): Promise<void> => {
    const record = JSON.parse(readFileSync(path(ref), "utf8")) as { pid: number; birth: string };
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && /^\d+$/.test(record.birth));
    const exited = (): boolean => {
      const currentBirth = birth(record.pid);
      if (currentBirth === undefined || currentBirth !== record.birth) return true;
      const pidfd = pidfdOpen(record.pid);
      if (pidfd === undefined) return true;
      try {
        if (birth(record.pid) !== record.birth) return true;
        // Match custody's native proof: pidfd poll accepts an exited, unreaped child as gone.
        return pidfdExited(pidfd);
      } finally {
        closeSync(pidfd);
      }
    };
    const deadline = Date.now() + 5_000;
    while (!exited()) {
      if (Date.now() >= deadline) throw new Error("childless fixture process remains alive");
      await sleep(20);
    }
  };
  const spawn = runtime.spawn.bind(runtime);
  return Object.assign(runtime, {
    supportsWorkClosure: true,
    reserve: (): RuntimeReference => ({ kind: runtime.kind, id: randomUUID() }),
    reapWork,
    reap: async (ref: RuntimeReference) => {
      await reapWork(ref);
      return { outcome: "reaped" as const, detail: "allowlisted childless fixture exited" };
    },
    spawn(name: string, spec: LaunchSpec, cwd: string, ref?: RuntimeReference) {
      assert.ok(accepts(spec), "the closure fixture refuses programs outside its childless allowlist");
      assert.ok(ref, "fixture requires pre-recorded launch custody");
      const handle = spawn(name, spec, cwd);
      assert.ok(handle.pid);
      const token = birth(handle.pid);
      assert.ok(token, "fixture child birth must be observed at launch");
      writeFileSync(path(ref), JSON.stringify({ pid: handle.pid, birth: token }), { flag: "wx", mode: 0o600 });
      return Object.assign(handle, { reference: ref, waitForWorkExit: async () => { await handle.waitForExit!(); await reapWork(ref); } });
    },
  });
}
