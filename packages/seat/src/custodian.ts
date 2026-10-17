import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { inSeatCgroup } from "./cgroup.js";
import { createServer, type Socket } from "node:net";
import { dropPidfdForTest, spawnPinned, type PinnedPty } from "./pty.js";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { peerCredentials, tryLockFd } from "./peercred.js";
import {
  CONFIRM_TIMEOUT_MS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FrameReader,
  GRACE_MS,
  MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
  SCROLLBACK_ROWS,
  UNATTENDED_MS as UNATTENDED_DEFAULT_MS,
  encodeFrame,
  type ClientRequest,
  type ServerMessage,
} from "./protocol.js";
import { RECORD_VERSION, bootToken, processStartToken, writeRecord, type SeatRecord } from "./record.js";
import { StartupConfirmMatcher, unmatchedConfirmMessage } from "./startup-confirm.js";

export interface CustodianLaunch {
  id: string;
  name: string;
  command: string;
  args: string[] | string;
  env: Record<string, string>;
  cwd: string;
  socket: string;
  token: string;
  recordPath: string;
  /** The launch fence (`<root>/.launch-<id>`): admission is its unsealed lock, held until ready. */
  fence: string;
  logPath?: string;
  confirm?: string;
  /** Who started this custodian: the launcher's run marker, carried so a census can attribute an
   *  orphan to its run without walking `/proc/*\/cwd` (#1648). */
  run?: string;
  /** How long to stay up with no authenticated controller before stopping the child and exiting.
   *  Resolved by the LAUNCHER, because the launcher scrubs the environment it hands this process
   *  (the child must not inherit the caller's), so an env override read here would never see one. */
  unattendedMs?: number;
  /** The layer 3 seat cgroup the launcher moves this process into. No child is spawned outside it. */
  cgroup?: string;
  /** The only uid whose connections this custodian serves: the launcher's. With a distinct agent uid
   *  it is not this process's uid, so the agent cannot drive its own seat. */
  adopterUid: number;
}

/** The stdin payload `launchSeat` writes: a launch plus the seam `setCustodianTestSeam` set. */
type LaunchPayload = CustodianLaunch & { testSeam?: CustodianTestSeam };

/** Test-only control points. A production launch never carries one. */
export interface CustodianTestSeam {
  /** Drop the fork's pidfd, as a kernel without `pidfd_open` would. */
  dropPidfd?: boolean;
  /** Pause at each `at`: write `reached`, then wait until `release` exists, for up to `timeoutMs`
   *  (default CONFIRM_TIMEOUT_MS). `unpinned` pauses after a failed pin, so a test child can arm its
   *  handlers before this process exits and hangs it up. */
  holds?: Array<{ at: "before-fs" | "after-pin" | "unpinned"; reached: string; release: string; timeoutMs?: number }>;
  /** Fail startup at this point, after the child is pinned. */
  fail?: "after-pin" | "listen-error" | "after-bind";
  /** Make the delayed SIGKILL of a graceful stop fail, as a send the kernel refused would. */
  failEscalation?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function send(sock: Socket, msg: ServerMessage): void {
  if (!sock.writable) return;
  sock.write(encodeFrame(msg));
}

export function runCustodian(launch: CustodianLaunch): Promise<void> {
  return custody(launch, undefined);
}

// The seam reaches here only from the stdin payload, never from the exported entry point.
async function custody(launch: CustodianLaunch, seam: CustodianTestSeam | undefined): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(`custody transport unsupported on ${process.platform}`);
  }
  const startedAt = Date.now();
  if (!Number.isInteger(launch.adopterUid) || launch.adopterUid < 0) throw new Error(`launch adopterUid ${String(launch.adopterUid)} is not a uid; starting no child`);
  const holdAt = async (at: "before-fs" | "after-pin" | "unpinned"): Promise<void> => {
    const hold = seam?.holds?.find((h) => h.at === at);
    if (!hold) return;
    writeFileSync(hold.reached, String(process.pid));
    const deadline = Date.now() + (hold.timeoutMs ?? CONFIRM_TIMEOUT_MS);
    while (!existsSync(hold.release)) {
      if (Date.now() >= deadline) throw new Error(`test seam hold at ${at} was never released`);
      await sleep(25);
    }
  };
  await holdAt("before-fs");

  // Admission. Read-only and without O_CREAT: a fence that is gone admits nothing, and the read goes
  // through this fd so a rename after the open cannot hide a seal.
  const fenceFd = openSync(launch.fence, "r");
  const admitBy = Date.now() + CONFIRM_TIMEOUT_MS;
  while (!tryLockFd(fenceFd)) {
    if (Date.now() >= admitBy) throw new Error(`launch fence ${launch.fence} stayed locked for ${CONFIRM_TIMEOUT_MS}ms; starting no child`);
    await sleep(25);
  }
  if (readFileSync(fenceFd, "utf8").trim() === "sealed") throw new Error(`launch fence ${launch.fence} is sealed; the seat was released, starting no child`);

  // Membership is checked under the fence lock. A removed cgroup can never be joined, so it fails at once.
  if (launch.cgroup !== undefined) {
    const cgroup = { path: launch.cgroup };
    while (!inSeatCgroup(cgroup)) {
      if (!existsSync(cgroup.path)) throw new Error(`seat cgroup ${cgroup.path} was removed before this custodian joined it; starting no child`);
      if (Date.now() >= startedAt + CONFIRM_TIMEOUT_MS) throw new Error(`custodian is not in seat cgroup ${cgroup.path} after ${CONFIRM_TIMEOUT_MS}ms; starting no child`);
      await sleep(25);
    }
  }

  try {
    unlinkSync(launch.socket);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  // Read before the spawn so a missing custodian identity fails with no child.
  const custodianStart = processStartToken(process.pid);
  if (custodianStart === undefined) throw new Error(`cannot read the process start identity of custodian ${process.pid} from /proc`);
  const bootId = bootToken();

  if (seam?.dropPidfd) dropPidfdForTest();
  if (typeof launch.args === "string") throw new Error("args as a string is not supported on unix.");
  // A throw here sends nothing: without a pidfd this process cannot name the child, and its exit
  // hangs up the PTY instead.
  let proc: PinnedPty;
  try {
    proc = spawnPinned(launch.command, launch.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: launch.cwd,
      env: launch.env,
    });
  } catch (e) {
    await holdAt("unpinned");
    throw e;
  }
  // From here until ready every failure stops the child through its pidfd, before any log write.
  try {
    await serveSeat(launch, proc, { custodianStart, bootId, fenceFd, holdAt, seam });
  } catch (cause) {
    try {
      proc.handle.signal("SIGKILL");
    } catch (e) {
      throw new Error(`${(cause as Error).message}; and the startup SIGKILL failed: ${(e as Error).message}`);
    }
    throw cause;
  }
}

async function serveSeat(
  launch: CustodianLaunch,
  proc: PinnedPty,
  pinned: { custodianStart: string; bootId: string | undefined; fenceFd: number; holdAt: (at: "after-pin") => Promise<void>; seam: CustodianTestSeam | undefined },
): Promise<void> {
  const { custodianStart, bootId, seam } = pinned;
  const child = proc.handle;
  // Timer callbacks log through this: a throw there would end the custodian before the escalation.
  const logNote = (note: string): void => {
    if (!launch.logPath) return;
    try {
      appendFileSync(launch.logPath, note, { mode: 0o600 });
    } catch {
      /* best effort; the send already happened */
    }
  };
  // A zombie still reports its start token; keep it only if the pidfd still reported the child live
  // after the read, so the token cannot belong to a reused pid.
  const childStartRead = processStartToken(proc.pid);
  const childStart = child.exited() ? undefined : childStartRead;
  await pinned.holdAt("after-pin");
  if (seam?.fail === "after-pin") throw new Error("test seam: startup failure after pinning");
  const term = new Headless.Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    scrollback: SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  let alive = true;
  let ready = false;
  let settling = false;
  let seenClient = false;
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let exit: { code?: number; signal?: number } | undefined;
  const dataSubs = new Map<number, Set<Socket>>();
  const waiters = new Map<Socket, Set<number>>();
  const controllers = new Set<Socket>();
  const clients = new Set<Socket>();
  let nextSub = 1;
  let early = "";
  const confirmMatcher = launch.confirm ? new StartupConfirmMatcher(launch.confirm) : undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  let unattendedTimer: ReturnType<typeof setTimeout> | undefined;
  let reap: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  /** Wait for the first adopter when the child has already exited at listen. */
  const LAUNCH_HANDOFF_MS = 5_000;
  const UNATTENDED_MS = launch.unattendedMs ?? UNATTENDED_DEFAULT_MS;

  if (confirmMatcher) {
    confirmTimer = setTimeout(() => {
      if (!alive) return;
      const message = unmatchedConfirmMessage(confirmMatcher.prompt, CONFIRM_TIMEOUT_MS);
      term.write(`\r\n${message}\r\n`);
      const encoded = Buffer.from(`\r\n${message}\r\n`, "utf8").toString("base64");
      for (const [sub, socks] of dataSubs) {
        for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
      }
      // Send before the log write, so a failed write cannot skip the stop.
      stopFromTimer("startup-confirm timeout");
      logNote(`${message}\n`);
    }, CONFIRM_TIMEOUT_MS);
  }

  const snapshot = (): Promise<string> =>
    new Promise((resolve) => term.write("", () => resolve(serializer.serialize())));

  const resolveWaiters = (): void => {
    for (const [sock, ids] of waiters) {
      for (const id of ids) send(sock, { id, ok: true, op: "wait-exit", exit });
    }
    waiters.clear();
  };

  // The pidfd, never `/proc/<pid>`: a reused pid must not read as this child still running.
  const childGone = (): boolean => child.exited();

  const settleTerminal = (): void => {
    if (alive || settling || !ready) return;
    // Only an AUTHENTICATED peer holds this custodian open. A connected socket that never said
    // hello owns no session, no output subscription and no wait, so it is owed nothing by a settle,
    // and counting it kept a custodian whose child had already exited resident for nothing: one
    // unauthenticated dial (a probe, a half-open connect) pinned ~65 MB for the life of the host.
    // Every authed socket is added to `controllers` by the same `hello` that authenticates it and
    // removed by `drop`, so this is exactly "someone can still be told something".
    if (controllers.size > 0) return;
    if (!seenClient) return;
    settling = true;
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (handoffTimer) {
      clearTimeout(handoffTimer);
      handoffTimer = undefined;
    }
    if (unattendedTimer) {
      clearTimeout(unattendedTimer);
      unattendedTimer = undefined;
    }
    if (reap) {
      clearInterval(reap);
      reap = undefined;
    }
    try {
      term.dispose();
    } catch {
      /* already gone */
    }
    server?.close();
    for (const sock of clients) {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    controllers.clear();
    waiters.clear();
    dataSubs.clear();
    try {
      unlinkSync(launch.socket);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    process.exit(0);
  };

  /**
   * Bound the time this custodian runs with NOBODY authenticated to it. A manager that crashed, or a
   * suite that returned without reaping, leaves a live child and a custodian that will otherwise wait
   * forever for a controller that no longer exists (#1648).
   *
   * Armed whenever the controller set is empty and disarmed the moment one authenticates, so an
   * ordinary detach-and-re-adopt never trips it: the window restarts from the last disconnect, not
   * from launch. The child is stopped rather than left behind, because this custodian owns the only
   * reader of its PTY; the settle that follows its exit is the ordinary one.
   */
  const armUnattended = (): void => {
    if (settling || !ready || unattendedTimer || controllers.size > 0) return;
    unattendedTimer = setTimeout(() => {
      unattendedTimer = undefined;
      if (settling || controllers.size > 0) return;
      // An unattended custodian has nobody to tell, so record the reason where an operator reading
      // an empty seat directory can still find it.
      const note = `${JSON.stringify({ unattended: true, afterMs: UNATTENDED_MS, childPid: proc.pid, custodianPid: process.pid, run: launch.run })}\n`;
      if (launch.logPath) {
        try {
          appendFileSync(launch.logPath, note, { mode: 0o600 });
        } catch {
          /* the seat directory may already be gone */
        }
      }
      if (alive) {
        // `seenClient` gates the settle, and a custodian nobody ever adopted must still be able to
        // exit: without this the stop below kills the child and the settle refuses, which is the
        // orphan again with a dead child instead of a live one.
        seenClient = true;
        stopFromTimer("unattended");
        // The settle runs off the child's exit. If the child ignores SIGTERM, `stopChild`'s own
        // SIGKILL escalation takes it within GRACE_MS and `markExited` follows from that.
        return;
      }
      seenClient = true;
      settleTerminal();
    }, UNATTENDED_MS);
    unattendedTimer.unref();
  };

  const disarmUnattended = (): void => {
    if (!unattendedTimer) return;
    clearTimeout(unattendedTimer);
    unattendedTimer = undefined;
  };

  const armUnobservedHandoff = (): void => {
    if (alive || seenClient || settling || !ready || handoffTimer) return;
    handoffTimer = setTimeout(() => {
      handoffTimer = undefined;
      seenClient = true;
      settleTerminal();
    }, LAUNCH_HANDOFF_MS);
    handoffTimer.unref();
  };

  const markExited = (info?: { code?: number; signal?: number }): void => {
    if (!alive) {
      resolveWaiters();
      settleTerminal();
      armUnobservedHandoff();
      return;
    }
    alive = false;
    exit = info ?? exit ?? {};
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
    for (const sock of controllers) send(sock, { event: "exit" });
    resolveWaiters();
    settleTerminal();
    armUnobservedHandoff();
  };

  proc.onData((d) => {
    term.write(d);
    if (early.length < MAX_FRAME_SIZE) {
      early += early.length + d.length > MAX_FRAME_SIZE ? d.slice(0, MAX_FRAME_SIZE - early.length) : d;
    }
    const encoded = Buffer.from(d, "utf8").toString("base64");
    for (const [sub, socks] of dataSubs) {
      for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
    }
    if (confirmMatcher?.push(d)) {
      proc.write("\r");
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
  });
  proc.onExit(({ exitCode, signal }) => {
    markExited({ code: exitCode, ...(signal === undefined ? {} : { signal }) });
  });
  reap = setInterval(() => {
    if (!alive) {
      if (reap) clearInterval(reap);
      reap = undefined;
      return;
    }
    if (childGone()) markExited({});
  }, 50);
  reap.unref();

  // Every send goes through the pidfd. A first send that fails throws, so `stop` replies with the
  // error; a failed delayed SIGKILL has no requester and is logged instead.
  const stopChild = (mode: "graceful" | "hard"): void => {
    if (!alive) return;
    if (mode === "hard") {
      child.signal("SIGKILL");
      return;
    }
    child.signal("SIGTERM");
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      if (!alive) return;
      try {
        if (seam?.failEscalation) throw new Error("test seam: delayed SIGKILL send failed");
        child.signal("SIGKILL");
      } catch (e) {
        const note = `${JSON.stringify({ escalationFailed: (e as Error).message, childPid: proc.pid })}\n`;
        logNote(note);
      }
    }, GRACE_MS);
  };
  // A timer has no requester to reply to, and a throw here would kill the custodian with the child
  // still under it: log the failed send instead.
  const stopFromTimer = (why: string): void => {
    try {
      stopChild("graceful");
    } catch (e) {
      const note = `${JSON.stringify({ stopFailed: (e as Error).message, why, childPid: proc.pid })}\n`;
      logNote(note);
    }
  };

  const record: SeatRecord = {
    version: RECORD_VERSION,
    id: launch.id,
    name: launch.name,
    socket: launch.socket,
    token: launch.token,
    custodianPid: process.pid,
    childPid: proc.pid,
    custodianStart,
    ...(childStart === undefined ? {} : { childStart }),
    // Bind the pids to THIS boot: their start tokens are ticks since boot and the record outlives a
    // reboot on disk, so without this a survivor could match an innocent process on the next boot.
    ...(bootId === undefined ? {} : { bootId }),
  };

  server = createServer((sock) => {
    const reader = new FrameReader();
    let authed = false;
    const owned = new Set<number>();
    clients.add(sock);
    const drop = (): void => {
      clients.delete(sock);
      controllers.delete(sock);
      for (const sub of owned) {
        const socks = dataSubs.get(sub);
        if (!socks) continue;
        socks.delete(sock);
        if (socks.size === 0) dataSubs.delete(sub);
      }
      owned.clear();
      waiters.delete(sock);
      settleTerminal();
      // A settle exits the process, so reaching here means this custodian is staying up. If that was
      // the last controller, it is now unattended and the bound starts from this disconnect.
      armUnattended();
    };
    sock.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const raw of messages) {
        void handle(sock, raw, {
          authed: () => authed,
          setAuthed: (v) => {
            authed = v;
          },
          owned,
        }).catch((err) => {
          send(sock, { id: (raw as { id?: number }).id ?? 0, ok: false, error: (err as Error).message });
        });
      }
    });
    sock.on("close", drop);
    sock.on("error", drop);
  });

  async function handle(
    sock: Socket,
    raw: unknown,
    session: { authed: () => boolean; setAuthed: (v: boolean) => void; owned: Set<number> },
  ): Promise<void> {
    const req = raw as ClientRequest;
    if (typeof req !== "object" || req === null || typeof req.id !== "number" || typeof req.op !== "string") {
      send(sock, { id: 0, ok: false, error: "malformed request" });
      return;
    }
    try {
      const cred = peerCredentials(sock);
      if (cred.uid !== launch.adopterUid) {
        send(sock, { id: req.id, ok: false, error: "peer uid mismatch" });
        sock.destroy();
        return;
      }
    } catch (e) {
      send(sock, { id: req.id, ok: false, error: (e as Error).message });
      sock.destroy();
      return;
    }
    if (req.op !== "hello" && !session.authed()) {
      send(sock, { id: req.id, ok: false, error: "not authenticated" });
      sock.destroy();
      return;
    }
    switch (req.op) {
      case "hello": {
        if (req.token !== launch.token) {
          send(sock, { id: req.id, ok: false, error: "capability token mismatch" });
          sock.destroy();
          return;
        }
        session.setAuthed(true);
        seenClient = true;
        // Join the controller set BEFORE anything below can settle. `markExited` runs the settle,
        // and a settle with no controller tears this socket down mid-`hello`, so the peer that just
        // authenticated would see "custodian socket closed" instead of its reply.
        controllers.add(sock);
        disarmUnattended();
        if (handoffTimer) {
          clearTimeout(handoffTimer);
          handoffTimer = undefined;
        }
        if (alive && childGone()) markExited({});
        send(sock, {
          id: req.id,
          ok: true,
          op: "hello",
          name: launch.name,
          pid: proc.pid,
          cols,
          rows,
          status: alive ? "running" : "exited",
          ...(exit ? { exit } : {}),
        });
        if (!alive) send(sock, { event: "exit" });
        return;
      }
      case "snapshot": {
        const data = await snapshot();
        send(sock, { id: req.id, ok: true, op: "snapshot", data, cols, rows });
        return;
      }
      case "subscribe-output": {
        const sub = nextSub++;
        const socks = dataSubs.get(sub) ?? new Set<Socket>();
        socks.add(sock);
        dataSubs.set(sub, socks);
        session.owned.add(sub);
        send(sock, { id: req.id, ok: true, op: "subscribe-output", sub });
        if (early) send(sock, { event: "output", sub, data: Buffer.from(early, "utf8").toString("base64") });
        if (!alive) send(sock, { event: "exit", sub });
        return;
      }
      case "unsubscribe-output": {
        const socks = dataSubs.get(req.sub);
        if (socks) {
          socks.delete(sock);
          if (socks.size === 0) dataSubs.delete(req.sub);
        }
        session.owned.delete(req.sub);
        send(sock, { id: req.id, ok: true, op: "unsubscribe-output" });
        return;
      }
      case "write": {
        if (!alive) throw new Error(`seat ${launch.name} is not running; the PTY rejected the write`);
        proc.write(req.data);
        send(sock, { id: req.id, ok: true, op: "write", bytes: Buffer.byteLength(req.data, "utf8") });
        return;
      }
      case "resize": {
        if (req.cols > 0 && req.rows > 0) {
          cols = req.cols;
          rows = req.rows;
          term.resize(req.cols, req.rows);
          if (alive) proc.resize(req.cols, req.rows);
        }
        send(sock, { id: req.id, ok: true, op: "resize" });
        return;
      }
      case "interrupt": {
        if (alive) proc.write("\x03");
        send(sock, { id: req.id, ok: true, op: "interrupt" });
        return;
      }
      case "stop": {
        stopChild(req.mode);
        send(sock, { id: req.id, ok: true, op: "stop" });
        return;
      }
      case "wait-exit": {
        if (alive && childGone()) markExited({});
        if (!alive) {
          send(sock, { id: req.id, ok: true, op: "wait-exit", exit });
          return;
        }
        const ids = waiters.get(sock) ?? new Set<number>();
        ids.add(req.id);
        waiters.set(sock, ids);
        return;
      }
      case "health": {
        if (alive && childGone()) markExited({});
        send(sock, {
          id: req.id,
          ok: true,
          op: "health",
          pid: proc.pid,
          status: alive ? "running" : "exited",
          protocol: PROTOCOL_VERSION,
        });
        return;
      }
      default: {
        const id = typeof (raw as { id?: unknown }).id === "number" ? (raw as { id: number }).id : 0;
        send(sock, { id, ok: false, error: "unknown op" });
      }
    }
  }

  const listening = server;
  if (!listening) throw new Error("custodian server missing");
  // A listen `error` rejects into `runCustodian`'s catch, which sends the startup SIGKILL.
  // Executor form: the repo's `lib` is ES2023, which has no `Promise.withResolvers`.
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const listened = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  listening.once("error", reject);
  if (seam?.fail === "listen-error") setImmediate(() => listening.emit("error", new Error("test seam: listen error")));
  else
    listening.listen(launch.socket, () => {
      // EVERY throw in here must reach `reject`. A callback is not on the promise's call stack, so an
      // exception raised inside it becomes an UNCAUGHT exception: it bypasses the `.catch` at the
      // bottom of this file that writes the log, and the process dies having explained nothing. The
      // launcher then reports only `custodian exited before ready: pid N gone`, which is what made a
      // silently-truncated socket path unattributable.
      try {
        // The bind can land on a DIFFERENT path than the one requested: libuv copies into a fixed
        // 108-byte `sun_path` and truncates rather than failing. `launchSeat` refuses an overlong
        // path up front, but a custodian can also be started directly, so verify what was actually
        // created rather than trusting that listen succeeded on the name we asked for.
        const bound = listening.address();
        if (typeof bound === "string" && bound !== launch.socket)
          throw new Error(`custodian bound ${bound} but was asked for ${launch.socket}; the path was truncated, so it would clean up a socket it never created`);
        chmodSync(launch.socket, 0o600);
        if (seam?.fail === "after-bind") throw new Error("test seam: startup failure after bind");
        writeRecord(launch.recordPath, record);
        ready = true;
        // Admission ends at ready. Nothing after writeRecord may throw: the launcher returns success
        // once the record exists, and process exit drops the lock anyway.
        try {
          closeSync(pinned.fenceFd);
        } catch {
          /* the lock goes with the fd at exit */
        }
        const announced = `${JSON.stringify({ ready: true, childPid: proc.pid, custodianPid: process.pid })}\n`;
        if (launch.logPath) logNote(announced);
        else process.stdout.write(announced);
        armUnobservedHandoff();
        armUnattended();
        settleTerminal();
        resolve();
      } catch (e) {
        reject(e as Error);
      }
    });
  await listened;
}

function readLaunch(): LaunchPayload {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) throw new Error("custodian requires a JSON launch on stdin");
  return JSON.parse(raw) as LaunchPayload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { testSeam, ...launch } = readLaunch();
  custody(launch, testSeam).catch((err) => {
    const text = `${(err as Error).stack ?? (err as Error).message}\n`;
    try {
      if (launch.logPath) appendFileSync(launch.logPath, text, { mode: 0o600 });
      else process.stderr.write(text);
    } catch {
      process.stderr.write(text);
    }
    process.exit(1);
  });
}
