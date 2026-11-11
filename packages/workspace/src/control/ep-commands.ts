export interface EpCommandMapping {
  command: string;
  targeted?: boolean;
  self?: boolean;
}
const freezeCommand = <const T extends EpCommandMapping>(mapping: T): Readonly<T> => Object.freeze(mapping);
/** v0.3 ctl op → v0.4 typed command. The wire names the manager's registered commands. `start`
 * creates (`spawn`); a named `stop` is the owner/any-mode terminal (`despawn`); per-agent `status`
 * reads `inspect`; camelCase admin operations map to kebab-case wire names. `targeted` marks the
 * commands whose `{name}` argument becomes a target block, resolved to the agent's principal triple
 * by the name-keyed `inspect` read. */
export const EP_COMMANDS = Object.freeze({
  managerStatus: freezeCommand({ command: "status" }),
  start: freezeCommand({ command: "spawn" }),
  resolveAgent: freezeCommand({ command: "resolve-agent" }),
  resolveCwd: freezeCommand({ command: "resolve-cwd" }),
  stop: freezeCommand({ command: "despawn", targeted: true }),
  stopSelf: freezeCommand({ command: "stop", self: true }),
  attach: freezeCommand({ command: "attach", targeted: true }),
  input: freezeCommand({ command: "input", targeted: true }),
  status: freezeCommand({ command: "inspect" }),
  ps: freezeCommand({ command: "ps" }),
  slots: freezeCommand({ command: "slots" }),
  models: freezeCommand({ command: "models" }),
  listPersonas: freezeCommand({ command: "list-personas" }),
  launch: freezeCommand({ command: "launch" }),
  purge: freezeCommand({ command: "purge" }),
  resumePreserved: freezeCommand({ command: "resume-preserved" }),
  commitResume: freezeCommand({ command: "commit-resume" }),
  finalizeResume: freezeCommand({ command: "finalize-resume" }),
  preparePreservation: freezeCommand({ command: "prepare-preservation" }),
  commitPreservation: freezeCommand({ command: "commit-preservation" }),
  abortPreservation: freezeCommand({ command: "abort-preservation" }),
  transcriptReceive: freezeCommand({ command: "transcript-receive" }),
  attestGone: freezeCommand({ command: "attest-gone" }),
  allowlistSet: freezeCommand({ command: "allowlist-set" }),
  chatSessionOpen: freezeCommand({ command: "chat-session-open" }),
  chatSessionRetire: freezeCommand({ command: "chat-session-retire" }),
  runPs: freezeCommand({ command: "run-ps" }),
  runStatus: freezeCommand({ command: "run-status" }),
} as const satisfies Record<string, EpCommandMapping>);
