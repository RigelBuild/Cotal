import { EpEnvelopeError } from "@cotal-ai/core";
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
