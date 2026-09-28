import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { runCommand, type CommandCtx } from "../src/console/commands.js";
import type { MeshSnapshot } from "../src/view/mesh-view.js";

type TestEndpoint = Pick<CotalEndpoint, "unicast">;
type TestCommandCtx = Omit<CommandCtx, "ep"> & { ep: TestEndpoint };

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

const endpointPeer: Presence = {
  card: { id: "manager-id", name: "manager", role: "manager", kind: "endpoint" },
  status: "idle",
  ts: Date.now(),
};
const agentPeer: Presence = {
  card: { id: "agent-id", name: "reviewer", role: "worker", kind: "agent" },
  status: "idle",
  ts: Date.now(),
};
const snapshot: MeshSnapshot = {
  agents: [agentPeer],
  endpoints: [endpointPeer],
  channels: [],
  feed: [],
  membership: {},
  rates: { msgsPerSec: 0, activity: [] },
  status: { connected: true, space: "dm-smoke", dmVisible: true },
  signals: { counts: { working: 0, waiting: 0, idle: 1, offline: 0 }, waiting: [], dms: [] },
  nameOf: (id) => id,
};
const sent: Array<{ id: string; text: string }> = [];
const notify: string[] = [];
let ensured = 0;
const ep = {
  unicast: async (id: string, text: string) => {
    sent.push({ id, text });
    return { id: "msg", ts: Date.now(), space: "dm-smoke", from: { id: "caller", name: "caller" }, to: id, parts: [{ kind: "text", text }] };
  },
} satisfies TestEndpoint;
const ctx: TestCommandCtx = {
  ep,
  snapshot,
  activeChannel: "general",
  setMode: () => {},
  setActiveChannel: () => {},
  toggleRail: () => {},
  openHelp: () => {},
  exit: () => {},
  notify: (message) => notify.push(message),
  control: async () => ({ ok: true }),
  ps: async () => ({ ok: true, rows: [], answered: [], silent: [], failed: [] }),
  confirmPurge: () => {},
  confirmDelchan: () => {},
  startAttach: () => {},
  ensureParticipant: async () => {
    ensured++;
    return true;
  },
};

const flushCommand = async (line: string): Promise<void> => {
  runCommand(line, ctx as CommandCtx, true, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
await flushCommand("dm manager review");
check(
  "console DM refuses an endpoint before participant activation or unicast",
  notify[0]?.includes('Cannot DM "manager"') && notify[0]?.includes("cotal_roster") && ensured === 0 && sent.length === 0,
  { notify, ensured, sent },
);
await flushCommand("dm manager-id review");
check(
  "console DM refuses an endpoint addressed by exact id",
  notify[1]?.includes('Cannot DM "manager"') && ensured === 0 && sent.length === 0,
  { notify, ensured, sent },
);
await flushCommand("call manager");
check(
  "console call refuses an endpoint without changing the DM lens",
  notify[2]?.includes('Cannot DM "manager"') && ensured === 0 && sent.length === 0,
  { notify, ensured, sent },
);
await flushCommand("dm reviewer review");
check(
  "console DM to an agent still activates the participant and sends",
  ensured === 1 && sent.length === 1 && sent[0]?.id === "agent-id" && sent[0]?.text === "review" && notify[3] === "→ reviewer",
  { notify, ensured, sent },
);

console.log(`\nconsole DM targets smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
