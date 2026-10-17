/**
 * Runtime attach smoke (no NATS, no test runner) — run with: pnpm smoke:attach
 *
 * Guards that `cotal attach` gives runtime-correct guidance: only `pty` streams over the WS
 * attach endpoint; `tmux`/`cmux` are watched natively, so each handle's attach() must throw its
 * OWN hint (this is what manager.opAttach surfaces). Regression target: before, opAttach assumed
 * "not pty == tmux" and told cmux users to run a tmux command. Spawns a throwaway `sleep` so it
 * needs no claude/mesh; tmux/cmux are skipped (logged) when not present on the machine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, requireRuntimeAdopt } from "../src/index.js";
import { isCustodialRuntime } from "../src/runtime/index.js";
import type { AgentHandle, LaunchSpec, Runtime } from "@cotal-ai/core";
import { detachKey } from "../../cli/src/lib/attach-client.js"; // the operator ws client moved into @cotal-ai/cli (stage 2a); dev-only smoke import
import "@cotal-ai/cmux"; // registers the `cmux` runtime provider
import "@cotal-ai/tmux"; // registers the `tmux` runtime provider

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
function skip(label: string, why: string): void {
  console.log(`• ${label} skipped (${why})`);
}
function closeHandle(h: unknown): void {
  const closer = h as { close?: () => void } | undefined;
  closer?.close?.();
}
function attachError(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const SESSION = "cotal-smoke";
const spec: LaunchSpec = { command: "sleep", args: ["60"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };
const cwd = process.cwd();

// pty (default) — the one streamable backend: attach() returns a live session, never throws.
{
  const h = createRuntime("pty", SESSION).spawn("smoke-pty", spec, cwd);
  let sess: { onData?: unknown; cols?: unknown } | undefined;
  const err = attachError(() => (sess = h.attach()));
  check(
    "pty: attach() returns a live session (streams, no throw)",
    err === "" && typeof sess?.onData === "function" && typeof sess?.cols === "number",
  );
  h.stop({ graceful: false });
  closeHandle(h);
}

// Runtime-selection contract (no fallbacks): `auto` is deterministic pty — even inside $TMUX. tmux
// and cmux are explicit-only, so being in a tmux session must NOT auto-select tmux.
{
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  check("auto resolves to pty (no $TMUX)", createRuntime("auto", SESSION).kind === "pty");
  process.env.TMUX = "/tmp/fake-tmux-socket";
  check("auto resolves to pty even inside $TMUX (no auto-detect, no fallback)", createRuntime("auto", SESSION).kind === "pty");
  if (prevTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = prevTmux;
}

// Detach key (no fallbacks): default is Ctrl-] (0x1d); `COTAL_DETACH_KEY` rebinds it to a control
// key; an unparseable value throws (named), never silently keeping the default.
{
  const prev = process.env.COTAL_DETACH_KEY;
  delete process.env.COTAL_DETACH_KEY;
  const def = detachKey();
  check("detach: default is Ctrl-] (0x1d), not overridden", def.byte === 0x1d && def.label === "Ctrl-]" && !def.overridden);

  process.env.COTAL_DETACH_KEY = "ctrl-b";
  const cb = detachKey();
  check("detach: COTAL_DETACH_KEY=ctrl-b → Ctrl-B (0x02), overridden", cb.byte === 0x02 && cb.label === "Ctrl-B" && cb.overridden);
  process.env.COTAL_DETACH_KEY = "^b";
  check("detach: caret form ^b parses the same", detachKey().byte === 0x02);
  process.env.COTAL_DETACH_KEY = "ctrl-]";
  check("detach: ctrl-] round-trips to the 0x1d default (overridden)", detachKey().byte === 0x1d && detachKey().overridden);

  // Unparseable values throw, naming the var — INCLUDING a set-but-empty/whitespace one (no fallback
  // to the default; only an unset var defaults).
  for (const bad of ["esc", "", "  "]) {
    process.env.COTAL_DETACH_KEY = bad;
    check(
      `detach: unparseable ${JSON.stringify(bad)} throws, naming the var (no silent fallback)`,
      attachError(() => detachKey()).includes("COTAL_DETACH_KEY"),
    );
  }
  if (prev === undefined) delete process.env.COTAL_DETACH_KEY;
  else process.env.COTAL_DETACH_KEY = prev;
}

// tmux — watched natively: attach() points you at `tmux attach-session -t <session>` + `select-window -t @N`.
{
  let rt: ReturnType<typeof createRuntime> | null = null;
  try {
    rt = createRuntime("tmux", SESSION);
  } catch (e) {
    skip("tmux", (e as Error).message);
  }
  if (rt) {
    const h = rt.spawn("smoke-tmux", spec, cwd);
    const err = attachError(() => h.attach());
    check(
      "tmux: attach() points at `tmux attach-session` + a select-window-by-id hint (not a stream)",
      err.includes("tmux attach-session -t cotal-smoke") && err.includes("select-window"),
    );
    check("tmux: hint is tmux-specific, never a cmux tab", !err.includes("cmux tab"));
    h.stop({ graceful: false });
    try {
      execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {
      /* session already gone */
    }
  }
}

// cmux — watched natively: attach() points you at the `cotal-<name>` tab, NOT tmux.
{
  let rt: ReturnType<typeof createRuntime> | null = null;
  try {
    rt = createRuntime("cmux", SESSION);
  } catch (e) {
    skip("cmux", (e as Error).message);
  }
  if (rt) {
    let h: ReturnType<typeof rt.spawn> | null = null;
    try {
      h = rt.spawn("smoke-cmux", spec, cwd);
    } catch (e) {
      skip("cmux", `spawn: ${(e as Error).message}`); // e.g. not inside a live cmux surface
    }
    if (h) {
      const err = attachError(() => h!.attach());
      check(
        'cmux: attach() points to the "cotal-smoke-cmux" tab (not tmux)',
        err.includes('switch to the "cotal-smoke-cmux" cmux tab') && !err.includes("tmux attach"),
      );
      h.stop({ graceful: false });
    }
  }
}

{
  const unsupported: Runtime = { kind: "fixture", spawn: () => { throw new Error("unused"); } };
  const err = attachError(() => requireRuntimeAdopt(unsupported, { kind: "fixture", id: "opaque" }));
  check('absent adopt refuses by runtime name', err === 'runtime "fixture" does not support adopt');

  const handle: AgentHandle = { name: "ok", kind: "capable", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => { throw new Error("unused"); } };
  const capable: Runtime = { kind: "capable", spawn: () => handle, adopt: () => handle };
  check("present adopt returns the runtime handle", requireRuntimeAdopt(capable, { kind: "capable", id: "opaque" }) === handle);
}

{
  const previousSeatRoot = process.env.COTAL_SEAT_ROOT;
  const seatRoot = process.platform === "linux" ? mkdtempSync(join(tmpdir(), "cotal-attach-pty-")) : undefined;
  if (seatRoot !== undefined) process.env.COTAL_SEAT_ROOT = seatRoot;
  let pty: Runtime | undefined;
  let spawned: AgentHandle | undefined;
  let adopted: AgentHandle | undefined;
  let ptyErr = "";
  try {
    // The fork keeps every Linux pty seat under a custodian, so a spawn carries a custody reference
    // the same runtime adopts; elsewhere pty spawns in-process and adopt refuses the transport.
    const runtime = createRuntime("pty", SESSION);
    pty = runtime;
    const handle = runtime.spawn("smoke-pty-adopt", spec, cwd);
    spawned = handle;
    ptyErr = attachError(() => (adopted = requireRuntimeAdopt(runtime, handle.reference ?? { kind: "pty", id: "missing" })));
    if (process.platform === "linux") {
      check(
        "pty adopt returns a live proxy of the same seat",
        ptyErr === "" && adopted !== undefined && typeof adopted.attach === "function" && adopted.pid === spawned.pid,
      );
    } else {
      check("pty spawn records no custody reference", spawned.reference === undefined);
      check(
        `pty adopt throws custody transport unsupported on ${process.platform}`,
        ptyErr === `custody transport unsupported on ${process.platform}`,
      );
    }
  } finally {
    try {
      if (spawned !== undefined) {
        spawned.stop({ graceful: false });
        await spawned.waitForExit?.();
        if (process.platform === "linux") {
          if (spawned.reference === undefined || pty === undefined || !isCustodialRuntime(pty))
            throw new Error("Linux pty seat has no reference or custodial runtime");
          await pty.reap(spawned.reference);
        }
      }
    } finally {
      closeHandle(spawned);
      closeHandle(adopted);
      try {
        if (seatRoot !== undefined) rmSync(seatRoot, { recursive: true, force: true });
      } finally {
        if (previousSeatRoot === undefined) delete process.env.COTAL_SEAT_ROOT;
        else process.env.COTAL_SEAT_ROOT = previousSeatRoot;
      }
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
