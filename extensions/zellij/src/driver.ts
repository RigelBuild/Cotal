import { execFileSync, spawn } from "node:child_process";

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

function run(args: string[], options: { encoding: "utf8" } | { stdio: "ignore" } = { encoding: "utf8" }): string {
  const result = execFileSync("zellij", args, options);
  return typeof result === "string" ? result.trim() : "";
}

function actionArgs(session: string, action: string[]): string[] {
  return ["--session", session, "action", ...action];
}

function hasNamedSession(output: string, session: string): boolean {
  return output.split("\n").some((line) => line.trim().split(/\s+/, 1)[0] === session);
}

function sessions(): string {
  return run(["list-sessions", "--no-formatting", "--short"]);
}

export function ensureSession(session: string): void {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(session))
    throw new Error(`zellij runtime: unsafe session name ${JSON.stringify(session)}`);
  try {
    if (hasNamedSession(sessions(), session)) return;
  } catch {
    // No reachable server means there cannot be an existing session.
  }
  run(["attach", "--create-background", session], { stdio: "ignore" });
}

function clientAttached(session: string): boolean {
  try {
    return run(actionArgs(session, ["list-clients"]))
      .split("\n")
      .some((line) => /^\d/.test(line.trim()));
  } catch {
    return false;
  }
}

function scriptAttachArgs(session: string): string[] {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(session))
    throw new Error(`zellij runtime: unsafe session name ${JSON.stringify(session)}`);
  return ["-qec", `zellij attach ${session}`, "/dev/null"];
}

export function ensureClient(session: string): void {
  if (clientAttached(session)) return;
  const env = { ...process.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  delete env.ZELLIJ_SESSION_NAME;
  const client = spawn("script", scriptAttachArgs(session), { detached: true, stdio: "ignore", env });
  client.on("error", () => {});
  if (!client.pid) throw new Error("zellij runtime: could not start a headless script client");
  client.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (clientAttached(session)) return;
    try {
      execFileSync("sleep", ["0.1"], { stdio: "ignore" });
    } catch {
      break;
    }
  }
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

export function listPanes(session: string): ZellijPane[] {
  ensureClient(session);
  const rows = parseArray(run(actionArgs(session, ["list-panes", "--json", "--all"])), "pane list");
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

export function buildNewPaneArgs(
  tabId: string,
  cwd: string,
  argv: readonly string[],
  placement: ZellijPlacement,
  name?: string,
): string[] {
  const args = ["new-pane", "--tab-id", tabId, "--no-focus"];
  if (placement.stacked === true) args.push("--stacked");
  else if (placement.floating === true) args.push("--floating");
  else if (placement.direction) args.push("--direction", placement.direction);
  else if (placement.stacked !== false && placement.floating !== false) args.push("--stacked");
  if (name) args.push("--name", name);
  args.push("--cwd", cwd, "--", ...argv);
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
  name: string,
  cwd: string,
  argv: readonly string[],
  placement: ZellijPlacement,
): string {
  ensureClient(session);
  const output = run(actionArgs(session, buildNewPaneArgs(tabId, cwd, argv, placement, name)));
  const id = output.trim();
  if (!/^terminal_\d+$/.test(id)) throw new Error(`zellij runtime: could not read pane ID from ${JSON.stringify(output)}`);
  return id;
}

export function closePane(session: string, paneId: string): void {
  ensureClient(session);
  run(actionArgs(session, ["close-pane", "-p", paneId]), { stdio: "ignore" });
}

export function interruptPane(session: string, paneId: string): void {
  ensureClient(session);
  run(actionArgs(session, ["write", "-p", paneId, "3"]), { stdio: "ignore" });
}

export function paneState(session: string, paneId: string): "running" | "exited" {
  const pane = listPanes(session).find((candidate) => candidate.id === paneId && !candidate.is_plugin);
  return !pane || pane.exited || pane.exit_status !== null ? "exited" : "running";
}

export async function waitForPaneExit(session: string, paneId: string): Promise<void> {
  for (;;) {
    try {
      if (paneState(session, paneId) === "exited") return;
    } catch {
      try {
        if (!hasNamedSession(sessions(), session)) return;
      } catch {
        return;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
