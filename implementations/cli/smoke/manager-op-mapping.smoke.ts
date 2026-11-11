/** CLI manager operations must map to commands registered by the manager contract. */
import assert from "node:assert/strict";
import { EP_COMMANDS } from "../../../packages/workspace/src/control/manager.js";
import { managerShippedSurface } from "../../manager/src/manager-service-contract.js";

// Keep this inventory aligned with the askManager/scatterManager operations in CLI source,
// including readSeats' ps/slots choice and the console's ControlOp calls.
const CLI_MANAGER_OPS = [
  "managerStatus", "attestGone", "allowlistSet", "stopSelf", "stop", "attach", "input", "ps", "slots",
  "preparePreservation", "abortPreservation", "commitPreservation", "models", "start", "resolveCwd", "resolveAgent",
  "transcriptReceive", "launch", "resumePreserved", "commitResume", "finalizeResume", "listPersonas",
  "status", "runPs", "runStatus", "purge",
] as const;
const managerCommands = managerShippedSurface().names;

for (const op of CLI_MANAGER_OPS) {
  const mapping = EP_COMMANDS[op];
  assert.ok(mapping, `CLI manager operation ${op} must have an EP_COMMANDS mapping`);
  assert.ok(managerCommands.includes(mapping.command), `${op} maps to unregistered manager command ${mapping.command}`);
}

for (const [op, mapping] of Object.entries(EP_COMMANDS)) {
  assert.ok(managerCommands.includes(mapping.command), `EP_COMMANDS entry ${op} maps to unregistered manager command ${mapping.command}`);
}

console.log(`manager-op-mapping.smoke: ${CLI_MANAGER_OPS.length} CLI operations resolve to manager contract commands`);
