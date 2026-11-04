import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenPrivate,
  registry,
  writeSecretFile,
  SpawnRefused,
  confirmWatch,
  type AgentHandle,
  type ConfirmPane,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";
import * as zellij from "./driver.js";
import { readZellijPlacement, type AgentPlacement } from "./placement.js";
const CONFIRM_BUDGET_MS = 1_000;

export interface PrivateLauncher {
  /** Runs the launcher script from `cwd`, so zellij's fallback pane title reads `./<agent>`. */
  readonly argv: string[];
  readonly cwd: string;
  readonly dir: string;
  readonly payload: string;
}

function launcherSource(dir: string, payload: string, name: string): string {
  return `#!${process.execPath}\n` +
    `const { spawn } = require("node:child_process");\n` +
    `const { closeSync, constants, lstatSync, openSync, readFileSync, rmSync, writeSync } = require("node:fs");\n` +
    `const dir = ${JSON.stringify(dir)};\n` +
    `const payload = ${JSON.stringify(payload)};\n` +
    `const alreadyRun = () => { console.error("[cotal-zellij-launch] this pane's launch has already run; respawn the agent through cotal"); process.exit(1); };\n` +
    // The pane closes with the launcher, so its last words also go to a file the runtime reports.
    // O_EXCL|O_NOFOLLOW: one reason per launch, never written through a planted file or link.
    `const report = (line) => { line = String(line).replace(/[\\x00-\\x1f\\x7f-\\x9f]/g, " ").slice(0, 500); console.error("[cotal-zellij-launch] " + line); try { const fd = openSync(dir + "/exit reason", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); writeSync(fd, line + "\\n"); closeSync(fd); } catch {} };\n` +
    `let dirInfo;\n` +
    `try { dirInfo = lstatSync(dir); } catch { alreadyRun(); }\n` +
    `if (!dirInfo.isDirectory() || (typeof process.getuid === "function" && (dirInfo.uid !== process.getuid() || (dirInfo.mode & 0o077) !== 0))) alreadyRun();\n` +
    // Installed only once the directory is ours, so a report never lands in a directory we did not make.
    `process.on("uncaughtException", (err) => { report("launcher: " + (err && err.message ? err.message : String(err))); process.exit(1); });\n` +
    `let launch;\n` +
    `try { launch = JSON.parse(readFileSync(payload, "utf8")); } catch (error) {\n` +
    `  try { rmSync(payload, { force: true }); } catch {}\n` +
    `  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") alreadyRun();\n` +
    `  throw error;\n` +
    `}\n` +
    `rmSync(payload, { force: true });\n` +
    `process.stdout.write("\\x1b]0;" + ${JSON.stringify(name.replace(/[\x00-\x1f\x7f-\x9f]/g, ""))} + "\\x07");\n` +
    `process.chdir(launch.cwd);\n` +
    `const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit" });\n` +
    `let exiting = false;\n` +
    `const forward = (signal) => { if (!exiting && child.pid) child.kill(signal); };\n` +
    `process.on("SIGINT", () => forward("SIGINT"));\n` +
    `process.on("SIGTERM", () => forward("SIGTERM"));\n` +
    `child.on("error", (err) => { report(launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal || code) report(launch.command + " exited with " + (signal ?? "code " + code)); if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}

export function privateLauncher(spec: LaunchSpec, cwd: string, name: string): PrivateLauncher {
  const dir = mkdtempSync(join(tmpdir(), "cotal-zellij-launch-"));
  hardenPrivate(dir, "dir");
  // A space keeps the payload name out of the sanitized script-name space.
  const payload = join(dir, "launch payload.json");
  writeSecretFile(payload, JSON.stringify({ cwd, command: spec.command, args: spec.args, env: spec.env ?? {} }));
  // Named after the agent for the pane title; it outlives the payload so a rerun reaches the "already run" message.
  const file = name.replace(/[^A-Za-z0-9_.-]/g, "_") || "agent";
  const script = join(dir, file);
  writeFileSync(script, launcherSource(dir, payload, name), { mode: 0o700 });
  chmodSync(script, 0o700);
  const argv = process.platform === "win32" ? [process.execPath, script] : [`./${file}`];
  return { argv, cwd: dir, dir, payload };
}

// What the launcher recorded before its pane closed, or "" when it exited cleanly or never ran.
// The launched agent shares our uid, so only a regular file opened without following links counts.
function exitReason(launcher: PrivateLauncher): string {
  let fd: number | undefined;
  try {
    fd = openSync(join(launcher.dir, "exit reason"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return "";
    // The launcher keeps 500 UTF-16 units, which is at most 1,500 UTF-8 bytes plus the newline.
    const buffer = Buffer.alloc(1_501);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, read).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function cleanupLauncher(launcher: PrivateLauncher): void {
  try {
    rmSync(launcher.dir, { recursive: true, force: true });
  } catch {
    /* the launcher removes its private payload before starting the child */
  }
}

const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;

/** zellij ignores `--cwd` for shell panes, so the typed line changes directory itself. */
export function launchLine(launcher: PrivateLauncher): string {
  return `cd ${shellQuote(launcher.cwd)} && exec ${launcher.argv.map(shellQuote).join(" ")}`;
}

function paneForTab(session: string, tabId: number, launcher: PrivateLauncher): string {
  const pane = zellij.listPanes(session).find((candidate) => candidate.tab_id === tabId && !candidate.is_plugin);
  if (pane) return pane.id;
  const reason = exitReason(launcher);
  const detail = reason ? `: ${reason}` : "";
  // Tab seats close on exit, so a launch that dies at once takes its tab with it.
  if (!zellij.listTabs(session).some((tab) => tab.tab_id === tabId)) {
    throw new Error(`zellij runtime: the agent in tab ${tabId} exited before its pane could be read${detail}`);
  }
  throw new Error(`zellij runtime: no terminal pane found in tab ${tabId}${detail}`);
}

export class ZellijRuntime implements Runtime {
  readonly kind = "zellij" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new SpawnRefused(`zellij runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!zellij.available()) throw new SpawnRefused("zellij runtime: zellij is not available — is it installed and on PATH?");
    let watch: ((pane: ConfirmPane) => void) | undefined;
    try {
      if (spec.confirmBefore?.length && spec.confirm === undefined) throw new Error("startup choices require a final confirmation prompt");
      watch = spec.confirm === undefined ? undefined : confirmWatch(spec.confirm, spec.confirmBefore);
    } catch (error) {
      throw new SpawnRefused(error instanceof Error ? error.message : String(error));
    }

    const placement = readZellijPlacement(spec.env?.COTAL_AGENT_FILE);
    zellij.ensureSession(this.session);
    let paneId: string | undefined;
    let createdTabId: string | undefined;
    const targetTabName = placement?.tab ?? name;
    const tabsBefore = zellij.listTabs(this.session);
    const existingTab = placement?.tab
      ? tabsBefore.find((candidate) => candidate.name === placement.tab)
      : undefined;
    // Created last: every later failure path deletes it, and it holds the connector's secrets.
    const launcher = privateLauncher(spec, cwd, name);
    try {
      if (!placement?.tab || !existingTab) {
        createdTabId = zellij.createTab(this.session, targetTabName, launcher.cwd, launcher.argv);
        paneId = paneForTab(this.session, Number(createdTabId), launcher);
      } else {
        paneId = zellij.createPane(
          this.session,
          String(existingTab.tab_id),
          launcher.cwd,
          launchLine(launcher),
          placement,
        );
      }
    } catch (error) {
      try {
        if (paneId) zellij.closePane(this.session, paneId);
        else {
          const partialTabId = createdTabId ?? zellij.listTabs(this.session)
            .find((candidate) => candidate.name === targetTabName && !tabsBefore.some((previous) => previous.tab_id === candidate.tab_id))
            ?.tab_id.toString();
          if (partialTabId) zellij.closeTab(this.session, partialTabId);
        }
      } catch {
        /* best-effort teardown of a partially created agent */
      }
      cleanupLauncher(launcher);
      throw error;
    }

    const startedPane = paneId;
    watch?.({
      read: () => zellij.dumpScreen(this.session, startedPane, Date.now() + CONFIRM_BUDGET_MS),
      enter: () => zellij.writePane(this.session, startedPane, "13", Date.now() + CONFIRM_BUDGET_MS),
      down: () => zellij.writeKeyDown(this.session, startedPane, Date.now() + CONFIRM_BUDGET_MS),
      fail: (message) => {
        console.error(`zellij runtime: "${name}": ${message}`);
        try {
          zellij.closePane(this.session, startedPane, Date.now() + CONFIRM_BUDGET_MS);
        } catch (error) {
          console.error(`zellij runtime: failed to close pane for "${name}":`, error);
        }
        cleanupLauncher(launcher);
      },
    });

    // One held subscriber per seat replaces per-call list-panes polling for status and exit.
    const exitWatch = new zellij.PaneWatch(this.session, startedPane, () => {
      const reason = exitReason(launcher);
      if (reason) console.error(`zellij runtime: "${name}": ${reason}`);
      cleanupLauncher(launcher);
    });
    return {
      name,
      kind: "zellij",
      status: () => exitWatch.status(),
      stop: () => {
        try {
          zellij.closePane(this.session, startedPane);
        } finally {
          cleanupLauncher(launcher);
        }
      },
      interrupt: () => zellij.interruptPane(this.session, startedPane),
      waitForExit: () => exitWatch.waitForExit(),
      attach: () => {
        throw new Error(`zellij runtime: attach natively with zellij attach ${this.session}`);
      },
    };
  }
}

export const zellijRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "zellij",
  available: () => zellij.available(),
  create: ({ session }) => {
    const target = process.env.COTAL_ZELLIJ_SESSION ?? session;
    zellij.ensureSession(target);
    return new ZellijRuntime(target);
  },
};

registry.register(zellijRuntimeProvider);
