import { EpEnvelopeError } from "@cotal-ai/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_OWNER, type EpCommandDef, type EpServeContext } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, managerClusterDocument } from "../src/manager-service-contract.js";
import { placementUnsupported } from "../src/placement-contract.js";

const names = ["place", "observe", "stop-placement", "prepare-launch", "profile-get"];
for (const name of names) {
  if (!managerClusterDocument().commands.some((row) => row.name === name) || !MANAGER_CONTRACTS[name]) {
    throw new Error(`missing placement command ${name}`);
  }
}
const observe = MANAGER_CONTRACTS.observe;
if (!observe.input.validate({ name: "seat", generation: 1 }) ||
    observe.input.validate({ name: "seat", generation: 1, claim: {} }) ||
    observe.output.validate({ state: "running" })) {
  throw new Error("observe contract did not enforce its closed request and required response");
}
const profile = MANAGER_CONTRACTS["profile-get"];
if (!profile.input.validate({ name: "default" }) || profile.input.validate({ name: "default", path: "/tmp/roles" }) ||
    profile.output.validate({ name: "default" })) {
  throw new Error("profile contract accepted a caller path or incomplete response");
}
for (const seam of ["RuntimeProvider rebind/create", "retained placement observation", "RuntimeProvider stop", "trusted workspace/profile/assets preparation", "configured trusted roles CUE profile source"]) {
  try {
    placementUnsupported(seam);
    throw new Error(`expected refusal for ${seam}`);
  } catch (error) {
    if (!(error instanceof EpEnvelopeError) || error.code !== "unimplemented" || !error.message.includes(seam)) throw error;
  }
}


const root = mkdtempSync(join(tmpdir(), "cotal-placement-contract-"));
try {
  const snapshot = { name: "default", revision: "r1", configRevision: "c1", modelRoles: { default: "provider/model" }, sha256: "abc" };
  const requested: string[] = [];
  const authorizePlacement = (caller: EpServeContext["subject"]["caller"]) => caller.actor === "reconciler";
  const manager = new Manager({ space: "main", runtime: "pty", workspaceRoot: root, authorizePlacement, profileGet: async (name) => { requested.push(name); return snapshot; } });
  const absent = new Manager({ space: "main", runtime: "pty", workspaceRoot: root, authorizePlacement });
  // This test reaches the private service table without starting the broker.
  const managerSeam = manager as unknown as { managerServiceDefs(): EpCommandDef[] };
  const absentSeam = absent as unknown as { managerServiceDefs(): EpCommandDef[] };
  const managerDefs = managerSeam.managerServiceDefs();
  const absentDefs = absentSeam.managerServiceDefs();
  const context = (command: string, actor = "reconciler"): EpServeContext => ({
    identity: { endpoint: "manager", instanceId: "manager", epoch: 1 },
    subject: { plane: "request", route: "one", endpoint: "manager", command, target: null,
      caller: { owner: DEV_OWNER, actor, uid: "00112233445566778899aabbccddeeff" }, nonce: "ffeeddccbbaa99887766554433221100" },
    request: { v: 1, id: "ffeeddccbbaa99887766554433221100", args: { name: "default" } } as unknown as EpServeContext["request"],
  });
  const handler = (defs: EpCommandDef[], command: string) => {
    const def = defs.find((row) => row.command === command);
    if (!def) throw new Error(`missing handler ${command}`);
    return def.handler;
  };
  const actual = await handler(managerDefs, "profile-get")(context("profile-get"));
  if (actual !== snapshot || requested.length !== 1 || requested[0] !== "default" || !profile.output.validate(actual)) throw new Error("profile callback result was not served");
  for (const command of names) {
    let denied: unknown;
    try { await handler(managerDefs, command)(context(command, "operator")); } catch (error) { denied = error; }
    if (!(denied instanceof EpEnvelopeError) || denied.code !== "permission-denied") throw new Error(`${command} admitted operator`, { cause: denied });
  }
  if (requested.length !== 1) throw new Error("unauthorized caller reached profile source");
  for (const command of names) {
    const subject = command === "profile-get" ? absentDefs : managerDefs;
    let failure: unknown;
    try { await handler(subject, command)(context(command)); } catch (error) { failure = error; }
    if (!(failure instanceof EpEnvelopeError) || failure.code !== "unimplemented" || !failure.message.includes("unsupported")) throw new Error(`${command} did not refuse`, { cause: failure });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}