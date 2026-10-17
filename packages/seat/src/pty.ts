import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidfdExited, pidfdSignal } from "./peercred.js";
import { unsupportedTransport } from "./protocol.js";

/** The spawned child, named by the pidfd its fork opened. A send after the child exits reports
 *  `gone` and reaches no other process. */
export interface ChildHandle {
  readonly pid: number;
  signal(sig: "SIGTERM" | "SIGKILL"): "sent" | "gone";
  exited(): boolean;
}

/** A PTY child with no `kill` or `destroy`: node-pty's sends address a bare pid. */
export interface PinnedPty {
  readonly pid: number;
  readonly handle: ChildHandle;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface UnixTerminal {
  readonly pid: number;
  readonly _pidfd?: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function ptyNativePath(arch: string = process.arch): string {
  return join(packageRoot, "build", "Release", `linux-${arch}`, "pty.node");
}

// Reached only through the custodian's test seam; the package index does not export it.
let dropPidfd = false;
export function dropPidfdForTest(): void {
  dropPidfd = true;
}

/** Thrown by {@link spawnPinned} only when the fork is proved not to have started a child: the
 *  vendored node-pty refused before forking, or forkpty(3) itself failed. Any other throw may leave a
 *  child running (one is forked before the pidfd and nonblocking checks), so callers must treat it as
 *  a possibly live child. */
export class NoChildStarted extends Error {
  override name = "NoChildStarted";
}

/** The vendored node-pty's throws that come before, or from, a failed fork (lib/unixTerminal.js and
 *  src/unix/pty.cc). Matched exactly: an unknown message is never taken as proof of no child. */
const PRE_FORK_ERRORS: Readonly<Record<string, true>> = {
  "args as a string is not supported on unix.": true,
  "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, utf8, helperPath, onexit)": true,
  "forkpty(3) failed.": true,
};

/** The pidfd stays open for the life of this process, so a send after exit reports `gone`. One
 *  custodian process pins one child; this is not a pool API. */
export function spawnPinned(
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd?: string; env: Record<string, string> },
): PinnedPty {
  if (process.platform !== "linux") throw unsupportedTransport();
  const require = createRequire(import.meta.url);
  const { UnixTerminal } = require(join(packageRoot, "native", "node-pty", "lib", "unixTerminal.js")) as {
    UnixTerminal: new (file: string, args: string[], opts: object) => UnixTerminal;
  };
  let term: UnixTerminal;
  try {
    term = new UnixTerminal(file, args, opts);
  } catch (e) {
    if (e instanceof Error && Object.hasOwn(PRE_FORK_ERRORS, e.message)) throw new NoChildStarted(e.message, { cause: e });
    throw e;
  }
  const pidfd = dropPidfd ? undefined : term._pidfd;
  if (typeof pidfd !== "number")
    throw new Error(`the PTY fork returned no pidfd for child ${term.pid}; refusing to custody a child this process cannot name`);
  const pid = term.pid;
  return {
    pid,
    handle: { pid, signal: (sig) => pidfdSignal(pidfd, sig), exited: () => pidfdExited(pidfd) },
    onData: (cb) => void term.onData(cb),
    onExit: (cb) => void term.onExit(cb),
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
  };
}
