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
    let paneId: string;
    try {
      const targetTabName = placement?.tab;
      const tab = targetTabName
        ? zellij.listTabs(this.session).find((candidate) => candidate.name === targetTabName)
        : undefined;
      if (!targetTabName || !tab) {
        const tabId = zellij.createTab(this.session, targetTabName ?? name, cwd, launcher.argv);
        paneId = paneForTab(this.session, Number(tabId));
      } else {
        paneId = zellij.createPane(
          this.session,
          String(tab.tab_id),
          name,
          cwd,
          launcher.argv,
          placement,
        );
      }
    } catch (error) {
      cleanupLauncher(launcher);
      throw error;
    }

    return {
      name,
      kind: "zellij",
      status: () => {
        try {
          return zellij.paneState(this.session, paneId);
        } catch {
          return "running";
        }
      },
      stop: () => {
        try {
          zellij.closePane(this.session, paneId);
        } finally {
          cleanupLauncher(launcher);
        }
      },
      interrupt: () => zellij.interruptPane(this.session, paneId),
      waitForExit: () => zellij.waitForPaneExit(this.session, paneId),
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
