import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenPrivate,
  registry,
  writeSecretFile,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";
import * as zellij from "./driver.js";
import { readZellijPlacement, type AgentPlacement } from "./placement.js";

const CONFIRM_INTERVAL_MS = 1_000;
const MAX_CONFIRMS = 5;

export function scheduleConfirmation(
  confirm: string,
  write: () => void,
  schedule: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay),
): void {
  if (!confirm) return;
  for (let i = 1; i <= MAX_CONFIRMS; i++) schedule(write, i * CONFIRM_INTERVAL_MS);
}

interface LauncherPayload {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export interface PrivateLauncher {
  readonly argv: string[];
  readonly dir: string;
  readonly script: string;
}

function launcherSource(payload: LauncherPayload): string {
  return `import { spawn } from "node:child_process";\n` +
    `import { rmSync } from "node:fs";\n` +
    `const launch = ${JSON.stringify(payload)};\n` +
    `try { rmSync(new URL(".", import.meta.url), { recursive: true, force: true }); } catch {}\n` +
    `process.chdir(launch.cwd);\n` +
    `const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit" });\n` +
    `let exiting = false;\n` +
    `const forward = (signal) => { if (!exiting && child.pid) child.kill(signal); };\n` +
    `process.on("SIGINT", () => forward("SIGINT"));\n` +
    `process.on("SIGTERM", () => forward("SIGTERM"));\n` +
    `child.on("error", (err) => { console.error("[cotal-zellij-launch] " + launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}

export function privateLauncher(spec: LaunchSpec, cwd: string): PrivateLauncher {
  const dir = mkdtempSync(join(tmpdir(), "cotal-zellij-launch-"));
  hardenPrivate(dir, "dir");
  const script = join(dir, "launch.mjs");
  writeSecretFile(script, launcherSource({ cwd, command: spec.command, args: spec.args, env: spec.env ?? {} }));
  return { argv: [process.execPath, script], dir, script };
}

function cleanupLauncher(launcher: PrivateLauncher): void {
  try {
    rmSync(launcher.dir, { recursive: true, force: true });
  } catch {
    /* the launcher also removes itself after loading */
  }
}

function paneForTab(session: string, tabId: number): string {
  const pane = zellij.listPanes(session).find((candidate) => candidate.tab_id === tabId && !candidate.is_plugin);
  if (!pane) throw new Error(`zellij runtime: no terminal pane found in tab ${tabId}`);
  return pane.id;
}

export class ZellijRuntime implements Runtime {
  readonly kind = "zellij" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`zellij runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!zellij.available()) throw new Error("zellij runtime: zellij is not available — is it installed and on PATH?");
    const placement = readZellijPlacement(spec.env?.COTAL_AGENT_FILE);
    zellij.ensureSession(this.session);
    const launcher = privateLauncher(spec, cwd);
    let paneId: string | undefined;
    let createdTabId: string | undefined;
    const targetTabName = placement?.tab ?? name;
    const tabsBefore = zellij.listTabs(this.session);
    const existingTab = placement?.tab
      ? tabsBefore.find((candidate) => candidate.name === placement.tab)
      : undefined;
    try {
      if (!placement?.tab || !existingTab) {
        createdTabId = zellij.createTab(this.session, targetTabName, cwd, launcher.argv);
        paneId = paneForTab(this.session, Number(createdTabId));
      } else {
        paneId = zellij.createPane(
          this.session,
          String(existingTab.tab_id),
          name,
          cwd,
          launcher.argv,
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
    if (spec.confirm) {
      scheduleConfirmation(spec.confirm, () => {
        try {
          zellij.writePane(this.session, startedPane, "13");
        } catch {
          /* pane may already be gone */
        }
      });
    }

    return {
      name,
      kind: "zellij",
      status: () => {
        try {
          return zellij.paneState(this.session, startedPane);
        } catch {
          return "running";
        }
      },
      stop: () => {
        try {
          zellij.closePane(this.session, startedPane);
        } finally {
          cleanupLauncher(launcher);
        }
      },
      interrupt: () => zellij.interruptPane(this.session, startedPane),
      waitForExit: () => zellij.waitForPaneExit(this.session, startedPane),
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
