import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenPrivate, loadAgentFile, mkSecretDir, registry, writeSecretFile, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, eventChannel, launchEnv, materialEnv } from "@cotal-ai/connector-core";

// The pi extension bundle, copied into dist at build so the published package is self-contained.
const STANDALONE = fileURLToPath(
  import.meta.url.includes("/dist/") ? new URL("./standalone.js", import.meta.url) : new URL("../dist/standalone.js", import.meta.url),
);
const PI_PROVIDER_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY",
  "CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "NVIDIA_API_KEY", "KIMI_API_KEY", "HF_TOKEN", "COPILOT_GITHUB_TOKEN", "AI_GATEWAY_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

export const ompConnector: Connector = {
  kind: "connector", name: "omp", requires: ["omp"], supportsResume: true, supportsSessionContinuation: true, eventChannel,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume && opts.continueSession) throw new Error("omp connector: resume (fork source) and continueSession (same session) are mutually exclusive");
    if (opts.variant) throw new Error("omp connector: model variants (variant) are not implemented");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) throw new Error("omp connector: MCP tool-sharing is not implemented");
    const launchOptions = connectorLaunchOptions("omp", opts.launchOptions);
    for (const [key] of launchOptions) if (key !== "config") throw new Error(`omp connector: unknown launch option ${JSON.stringify(key)} (only config is supported)`);
    const config = launchOptions.find(([key]) => key === "config")?.[1];
    if (config !== undefined && typeof config !== "string") throw new Error("omp connector: launch option config must be a string path");

    let model = opts.model;
    let persona: string | undefined;
    if (opts.configPath) {
      const definition = loadAgentFile(opts.configPath);
      model ??= definition.model;
      persona = definition.persona;
    }
    const control = controlEndpoint(opts.space, opts.name);
    const stateRoot = opts.workspaceRoot ? join(opts.workspaceRoot, ".cotal", "pi-sessions") : undefined;
    const sessionStatePath = stateRoot ? join(stateRoot, `${opts.name}-${opts.lifecycleUid ?? "unmanaged"}.json`) : undefined;
    if (stateRoot) mkSecretDir(stateRoot);
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PI_PROVIDER_KEYS, envAllow: opts.envAllow }), ...aclEnv(opts),
      ...materialEnv({ creds: opts.creds, servers: opts.servers, controlToken: control.token, eventsRequired: opts.eventsRequired, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space, COTAL_NAME: opts.name,
    };
    if (opts.events !== false) {
      if (!opts.workspaceRoot) throw new Error("omp connector: events were requested without workspaceRoot for the durable event log");
      env.COTAL_EVENTS = "1"; env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    }
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.acceptedToken) env.COTAL_ACCEPTED_TOKEN = opts.acceptedToken;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;

    const args = ["--extension", STANDALONE];
    const freshSessionId = !opts.resume && !opts.continueSession ? randomUUID() : undefined;
    if (freshSessionId) env.COTAL_PI_FRESH_SESSION = "1";
    if (opts.resume) args.push("--fork", opts.resume);
    else if (opts.continueSession) args.push("--session-id", opts.continueSession);
    else if (freshSessionId) args.push("--session-id", freshSessionId);
    const expectedSessionId = opts.continueSession ?? freshSessionId;
    if (expectedSessionId) env.COTAL_PI_EXPECTED_SESSION = expectedSessionId;
    if (persona) {
      const dir = mkdtempSync(join(tmpdir(), "cotal-persona-")); hardenPrivate(dir, "dir");
      const file = join(dir, "persona.md"); writeSecretFile(file, persona);
      env.COTAL_PI_PERSONA_FILE = file; args.push("--append-system-prompt", file);
    }
    if (model) { env.COTAL_MODEL = model; args.push("--model", model); }
    if (config !== undefined) args.push("--config", config);
    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt) throw new Error("omp connector: an initial prompt was given but it is empty, there is no first turn to submit");
      if (prompt.startsWith("-") || prompt.startsWith("@")) throw new Error("omp connector: an initial prompt cannot start with '-' or '@' (omp reads those as an option or a file reference); reword it");
      args.push(prompt);
    }
    env.COTAL_CONTROL_SOCKET = control.path;
    if (sessionStatePath) env.COTAL_PI_SESSION_STATE = sessionStatePath;
    return { command: opts.resolvedBinaries?.omp ?? "omp", args, env, control, sessionStatePath };
  },
};

registry.register(ompConnector);
