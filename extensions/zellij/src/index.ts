/** @cotal-ai/zellij — self-registering runtime provider for agent panes in named Zellij sessions. */
export { ZellijRuntime, zellijRuntimeProvider, privateLauncher } from "./runtime.js";
export { HolderRuntime, holderRuntimeProvider } from "./holder.js";
export type { HolderReapEvidence } from "./holder.js";
export { parseZellijPlacement, readZellijPlacement } from "./placement.js";
export * as zellij from "./driver.js";
