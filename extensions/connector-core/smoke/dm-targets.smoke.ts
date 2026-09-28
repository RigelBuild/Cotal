import { CotalEndpoint, type CotalMessage, type Presence } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${String(detail)}`}`);
  }
};

const config: AgentConfig = {
  space: "dm-targets",
  name: "caller",
  servers: "nats://127.0.0.1:1",
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};
const agentPresence: Presence = {
  card: { id: "agent-id", name: "reviewer", role: "worker", kind: "agent" },
  status: "idle",
  ts: Date.now(),
};
const endpointPresence: Presence = {
  card: { id: "manager-id", name: "manager", role: "manager", kind: "endpoint" },
  status: "idle",
  activity: "agent host (zellij)",
  ts: Date.now(),
};
const roster = [
  { card: { id: "caller-id", name: "caller", kind: "agent" as const }, status: "idle" as const, ts: Date.now() },
  agentPresence,
  endpointPresence,
];
const unicastTargets: string[] = [];
const endpoint: Pick<CotalEndpoint, "card" | "getRoster" | "unicast"> = {
  card: roster[0].card,
  getRoster: () => roster,
  unicast: async (target, text): Promise<CotalMessage> => {
    unicastTargets.push(`${target}:${text}`);
    return {
      id: `message-${unicastTargets.length}`,
      ts: Date.now(),
      space: config.space,
      from: { id: "caller-id", name: "caller" },
      to: target,
      parts: [{ kind: "text", text }],
    };
  },
};
const agent = new MeshAgent(config);
const stage = agent as unknown as { _connected: boolean; ep: Pick<CotalEndpoint, "card" | "getRoster" | "unicast"> };
stage._connected = true;
stage.ep = endpoint;
const specs = cotalToolSpecs(config);
const rosterTool = specs.find((spec) => spec.name === "cotal_roster");
if (!rosterTool) throw new Error("cotal_roster spec is missing");
const rosterResult = await rosterTool.run(agent, config, {});
check(
  "cotal_roster marks endpoint rows and leaves agent rows unmarked",
  rosterResult.text.includes("manager/manager — idle: agent host (zellij) (endpoint; does not take DMs)") &&
    rosterResult.text.includes("reviewer/worker — idle") &&
    !rosterResult.text.includes("reviewer/worker — idle (endpoint; does not take DMs)"),
  rosterResult.text,
);

let endpointError = "";
try {
  await agent.dm("manager", "please review");
} catch (error) {
  endpointError = error instanceof Error ? error.message : String(error);
}
check(
  "DM to a mesh endpoint is refused with guidance to find an agent",
  endpointError.includes("manager") &&
    endpointError.includes("mesh endpoint") &&
    endpointError.includes("does not read direct messages") &&
    endpointError.includes("cotal_roster") &&
    unicastTargets.length === 0,
  endpointError || unicastTargets,
);
let endpointIdError = "";
try {
  await agent.dm("manager-id", "please review");
} catch (error) {
  endpointIdError = error instanceof Error ? error.message : String(error);
}
check(
  "DM to an endpoint by exact instance id is also refused before unicast",
  endpointIdError.includes('Cannot DM "manager"') && unicastTargets.length === 0,
  endpointIdError || unicastTargets,
);

const sent = await agent.dm("agent-id", "please review");
check(
  "DM to an agent by exact instance id is sent",
  sent.peer.card.kind === "agent" && unicastTargets.join(",") === "agent-id:please review",
  unicastTargets,
);


console.log(`\nDM targets smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
