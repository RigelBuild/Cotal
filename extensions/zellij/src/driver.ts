import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

export interface ZellijPlacement {
  readonly tab?: string;
  readonly stacked?: boolean;
  readonly floating?: boolean;
  readonly direction?: "right" | "down";
}

export interface ZellijTab {
  readonly tab_id: number;
  readonly name: string;
  readonly active?: boolean;
}

export interface ZellijPane {
  readonly id: string;
  readonly tab_id: number;
  readonly title: string;
  readonly is_plugin: boolean;
  readonly exited: boolean;
  readonly exit_status: number | null;
}

export function available(): boolean {
  try {
    execFileSync("zellij", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type RunOptions = { encoding: "utf8"; deadline?: number } | { stdio: "ignore"; deadline?: number };

/** The time left before an absolute deadline; past it, the operation fails rather than starting a call. */
function remaining(deadline: number | undefined): { timeout: number; killSignal: "SIGKILL" } | Record<string, never> {
  if (deadline === undefined) return {};
  const left = deadline - Date.now();
  if (left <= 0) throw new Error("zellij runtime: the operation deadline passed");
  return { timeout: left, killSignal: "SIGKILL" };
}

function run(args: string[], options: RunOptions = { encoding: "utf8" }): string {
  const { deadline, ...execOptions } = options;
  const result = execFileSync("zellij", args, { ...execOptions, ...remaining(deadline) });
  return typeof result === "string" ? result.trim() : "";
}


/** Read the active viewport of a terminal pane; every call shares one deadline so a watch cannot stall the manager. */
export function dumpScreen(session: string, paneId: string, deadline: number): string | undefined {
  if (paneState(session, paneId, deadline) === "exited") return undefined;
  let screen: string | undefined;
  try {
    screen = run(actionArgs(session, ["dump-screen", "--pane-id", paneId]), { encoding: "utf8", deadline });
  } catch (error) {
    if (Date.now() >= deadline) throw error;
  }
  if (paneState(session, paneId, deadline) === "exited") return undefined;
  if (screen === undefined) throw new Error(`zellij runtime: could not read pane ${paneId}`);
  return screen;
}

function actionArgs(session: string, action: string[]): string[] {
  return ["--session", session, "action", ...action];
}

const NO_SESSIONS = "No active zellij sessions found";

// Dead sessions stay listed (resurrectable) with an EXITED suffix; they are not live.
export function hasLiveSession(listing: string, session: string): boolean {
  return listing
    .split("\n")
    .some((line) => line.trim().split(/\s+/, 1)[0] === session && !line.includes("(EXITED"));
}

function isNoSessionsError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false;
  const { stderr } = error;
  return (typeof stderr === "string" || Buffer.isBuffer(stderr)) && String(stderr).includes(NO_SESSIONS);
}

// Only zellij's own "no sessions" answer means absent; any other probe failure throws, so a
// failed probe can never read as a confirmed exit.
function sessionExists(session: string, deadline?: number): boolean {
  let listing: string;
  try {
    listing = execFileSync("zellij", ["list-sessions", "--no-formatting"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...remaining(deadline),
    });
  } catch (error) {
    if (isNoSessionsError(error)) return false;
    throw error;
  }
  return hasLiveSession(listing, session);
}

export function ensureSession(session: string): void {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(session))
    throw new Error(`zellij runtime: unsafe session name ${JSON.stringify(session)}`);
  if (sessionExists(session)) return;
  run(["attach", "--create-background", session], { stdio: "ignore" });
}

// Client count, or undefined when the probe fails: a failed probe is not "no client".
function clientCount(session: string, deadline?: number): number | undefined {
  try {
    return run(actionArgs(session, ["list-clients"]), { encoding: "utf8", deadline })
      .split("\n")
      .filter((line) => /^\d/.test(line.trim())).length;
  } catch {
    return undefined;
  }
}

function attachCommand(session: string): string {
  return `stty cols 1000 rows 500; exec zellij attach ${session}`;
}

function scriptBin(): string {
  return process.env.COTAL_ZELLIJ_SCRIPT ?? "script";
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// Groups this process started; the fallback where /proc cannot be read.
const spawned = new Map<string, Set<number>>();

// True when pid is, right now, a group leader we own running our exact script(1) attach argv.
// Checked again just before each kill, so a reused PID is not signalled.
function isHeadless(pid: number, session: string): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const flag = argv.indexOf("-qec");
    if (flag < 1 || argv[flag + 1] !== attachCommand(session) || argv[flag + 2] !== "/dev/null") return false;
    if (baseName(argv[flag - 1]) !== baseName(scriptBin())) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2] !== String(pid)) return false;
    return process.getuid === undefined || statSync(`/proc/${pid}`).uid === process.getuid();
  } catch {
    return false;
  }
}

// Headless clients for a session from any manager process, so survivors of an earlier manager are
// found. Without /proc only the groups this process started are known.
function headlessGroups(session: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [...(spawned.get(session) ?? [])];
  }
  return entries.map(Number).filter((pid) => isHeadless(pid, session));
}

function stopGroup(session: string, pid: number, procfs: boolean): void {
  spawned.get(session)?.delete(pid);
  if (procfs && !isHeadless(pid, session)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

export function scriptAttachArgs(session: string): string[] {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(session))
    throw new Error(`zellij runtime: unsafe session name ${JSON.stringify(session)}`);
  return ["-qec", attachCommand(session), "/dev/null"];
}

function waitTick(until: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(100, until - Date.now())));
}

// A failed listing is unknown, never "no client": probe again until the budget ends.
function knownClientCount(session: string, until: number): number | undefined {
  let count = clientCount(session, until);
  while (count === undefined && Date.now() < until) {
    waitTick(until);
    count = clientCount(session, until);
  }
  return count;
}

function deadlineError(): Error {
  return new Error("zellij runtime: the operation deadline passed before a client could start");
}

export function ensureClient(session: string, deadline?: number): void {
  if (!sessionExists(session, deadline))
    throw new Error(`zellij runtime: session ${JSON.stringify(session)} does not exist`);
  const attachBy = deadline ?? Date.now() + 3_000;
  const unknown = (): Error =>
    deadline !== undefined ? deadlineError() : new Error(`zellij runtime: could not list clients of session ${JSON.stringify(session)}`);
  let count = knownClientCount(session, attachBy);
  if (count === undefined) throw unknown();
  // One attached client is the steady state, headless or real; only other counts need the scan.
  // list-clients has no process identity, so an unattached survivor beside a real client stays until it attaches.
  if (count !== 1) {
    const procfs = (() => { try { readdirSync("/proc"); return true; } catch { return false; } })();
    const groups = headlessGroups(session);
    // Keep one headless client only while it is the sole attached client. An unattached one is
    // stopped and replaced below, so a client still connecting is never duplicated.
    const keep = count > 0 && count <= groups.length ? 1 : 0;
    if (groups.length > keep) {
      for (const pid of groups.slice(keep)) stopGroup(session, pid, procfs);
      // The other client may have left meanwhile; start one only if a known listing shows none.
      count = knownClientCount(session, attachBy);
      if (count === undefined) throw unknown();
    }
  }
  if (count > 0) return;
  if (Date.now() >= attachBy) throw deadlineError();
  const env = { ...process.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  delete env.ZELLIJ_SESSION_NAME;
  const client = spawn(scriptBin(), scriptAttachArgs(session), { detached: true, stdio: "ignore", env });
  client.on("error", () => {});
  const pid = client.pid;
  if (!pid) throw new Error("zellij runtime: could not start a headless script client");
  const own = spawned.get(session) ?? new Set<number>();
  spawned.set(session, own.add(pid));
  client.on("exit", () => own.delete(pid));
  client.unref();
  while (Date.now() < attachBy) {
    if ((clientCount(session, attachBy) ?? 0) > 0) return;
    waitTick(attachBy);
  }
  // Only a bounded call leaves its own client behind on failure; an unbounded caller keeps today's behaviour.
  if (deadline !== undefined) stopGroup(session, pid, false);
  throw new Error(`zellij runtime: no client could attach to session ${JSON.stringify(session)}`);
}

function parseArray(raw: string, label: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`zellij runtime: invalid ${label} JSON: ${reason}`);
  }
  if (!Array.isArray(value)) throw new Error(`zellij runtime: invalid ${label} JSON (expected array)`);
  return value;
}

export function listTabs(session: string): ZellijTab[] {
  if (!sessionExists(session)) return [];
  const rows = parseArray(run(actionArgs(session, ["list-tabs", "--json"])), "tab list");
  return rows.flatMap((row): ZellijTab[] => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
    const id = Reflect.get(row, "tab_id");
    const name = Reflect.get(row, "name");
    const active = Reflect.get(row, "active");
    if (typeof id !== "number" || typeof name !== "string") return [];
    return [{ tab_id: id, name, ...(typeof active === "boolean" ? { active } : {}) }];
  });
}

export function listPanes(session: string, deadline?: number): ZellijPane[] {
  if (!sessionExists(session, deadline)) return [];
  const rows = parseArray(run(actionArgs(session, ["list-panes", "--json", "--all"]), { encoding: "utf8", deadline }), "pane list");
  return rows.flatMap((row): ZellijPane[] => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
    const id = Reflect.get(row, "id");
    const tabId = Reflect.get(row, "tab_id");
    const title = Reflect.get(row, "title");
    const isPlugin = Reflect.get(row, "is_plugin");
    const exited = Reflect.get(row, "exited");
    const exitStatus = Reflect.get(row, "exit_status");
    if (
      typeof id !== "number" || typeof tabId !== "number" || typeof title !== "string" ||
      typeof isPlugin !== "boolean" || typeof exited !== "boolean" ||
      (exitStatus !== null && typeof exitStatus !== "number")
    ) return [];
    return [{ id: `terminal_${id}`, tab_id: tabId, title, is_plugin: isPlugin, exited, exit_status: exitStatus }];
  });
}

// No `-- <cmd>`: zellij ignores OSC titles from command panes, so the agent is typed into a shell pane.
export function buildNewPaneArgs(tabId: string, cwd: string, placement: ZellijPlacement): string[] {
  const args = ["new-pane", "--tab-id", tabId, "--no-focus"];
  if (placement.stacked === true) args.push("--stacked");
  else if (placement.floating === true) args.push("--floating");
  else if (placement.direction) args.push("--direction", placement.direction);
  else if (placement.stacked !== false && placement.floating !== false) args.push("--stacked");
  args.push("--cwd", cwd);
  return args;
}

export function buildNewTabArgs(name: string, cwd: string, argv: readonly string[]): string[] {
  return ["new-tab", "--name", name, "--no-focus", "--cwd", cwd, "--", ...argv];
}

export function createTab(session: string, name: string, cwd: string, argv: readonly string[]): string {
  ensureClient(session);
  const output = run(actionArgs(session, buildNewTabArgs(name, cwd, argv)));
  const id = output.trim();
  if (!/^\d+$/.test(id)) throw new Error(`zellij runtime: could not read tab ID from ${JSON.stringify(output)}`);
  return id;
}

export function createEmptyTab(session: string, name: string, cwd: string): string {
  ensureClient(session);
  const output = run(actionArgs(session, ["new-tab", "--name", name, "--no-focus", "--cwd", cwd]));
  const id = output.trim();
  if (!/^\d+$/.test(id)) throw new Error(`zellij runtime: could not read tab ID from ${JSON.stringify(output)}`);
  return id;
}

export function createPane(
  session: string,
  tabId: string,
  cwd: string,
  command: string,
  placement: ZellijPlacement,
): string {
  ensureClient(session);
  let id = newPane(session, buildNewPaneArgs(tabId, cwd, placement));
  // zellij 0.45 can print an ID for a placed pane it then fails to add ("Failed to add pane to stack").
  if (!listPanes(session).some((pane) => !pane.is_plugin && pane.id === id))
    id = newPane(session, buildNewPaneArgs(tabId, cwd, { stacked: false, floating: false }));
  run(actionArgs(session, ["write-chars", "-p", id, command]), { stdio: "ignore" });
  run(actionArgs(session, buildWriteArgs(id, "13")), { stdio: "ignore" });
  return id;
}

function newPane(session: string, args: string[]): string {
  const output = run(actionArgs(session, args));
  const id = output.trim();
  if (!/^terminal_\d+$/.test(id)) throw new Error(`zellij runtime: could not read pane ID from ${JSON.stringify(output)}`);
  return id;
}

export function closePane(session: string, paneId: string, deadline?: number): void {
  if (!sessionExists(session, deadline)) return;
  ensureClient(session, deadline);
  run(actionArgs(session, ["close-pane", "-p", paneId]), { stdio: "ignore", deadline });
}

export function closeTab(session: string, tabId: string): void {
  if (!sessionExists(session)) return;
  ensureClient(session);
  run(actionArgs(session, ["close-tab", "--tab-id", tabId]), { stdio: "ignore" });
}
export function buildWriteArgs(paneId: string, input: string): string[] {
  return ["write", "-p", paneId, input];
}

export function writePane(session: string, paneId: string, input: string, deadline?: number): void {
  if (!sessionExists(session, deadline)) return;
  ensureClient(session, deadline);
  run(actionArgs(session, buildWriteArgs(paneId, input)), { stdio: "ignore", deadline });
}

export function writeKeyDown(session: string, paneId: string, deadline?: number): void {
  ensureClient(session, deadline);
  run(actionArgs(session, ["write", "-p", paneId, "27", "91", "66"]), { stdio: "ignore", deadline });
}
export function interruptPane(session: string, paneId: string): void {
  writePane(session, paneId, "3");
}

export function paneState(session: string, paneId: string, deadline?: number): "running" | "exited" {
  if (!sessionExists(session, deadline)) return "exited";
  const pane = listPanes(session, deadline).find((candidate) => candidate.id === paneId && !candidate.is_plugin);
  return !pane || pane.exited || pane.exit_status !== null ? "exited" : "running";
}

export async function waitForPaneExit(session: string, paneId: string): Promise<void> {
  for (;;) {
    try {
      if (paneState(session, paneId) === "exited") return;
    } catch {
      // A failed probe is not an exit; poll again.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
