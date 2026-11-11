/** Every internal manager operation maps to a command in the registered manager contract. */
import { createSuite } from "@cotal-ai/smoke-kit";
import { EP_COMMANDS } from "../../../packages/workspace/src/control/ep-commands.js";
import { managerShippedSurface } from "../../manager/src/manager-service-contract.js";

const { check, finish } = createSuite();
const managerCommands = managerShippedSurface().names;

for (const [op, mapping] of Object.entries(EP_COMMANDS))
  check(`EP_COMMANDS ${op} maps to a registered manager command`, managerCommands.includes(mapping.command), mapping.command);

finish();
