import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { loadMeshes, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { askManager, failIfNotOk, onFlag, onInstanceOrExit, resolveControlTarget, scatterManager, type ScatterInstanceReply } from "../lib/control.js";
import { completingFlagValue } from "../lib/completion.js";

export const allowlistFlags = [...targetFlags, onFlag] as const satisfies readonly FlagSpec[];

export function allowlistComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, allowlistFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  if (flag === undefined && argv.length <= 1) return { items: [{ value: "set" }], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
/** allowlist-set needs more than the default manager-invoke deadline. */
export const ALLOWLIST_SET_TIMEOUT_MS = 120_000;

export function allowlistSetOptions(on: string | undefined): { timeoutMs: number; pin?: { instanceId: string } } {
  return { timeoutMs: ALLOWLIST_SET_TIMEOUT_MS, ...(on === undefined ? {} : { pin: { instanceId: on } }) };
}

/** A reachable manager with no status data cannot prove that its allowlist is absent. */
export function allowlistStatusAmbiguity(instances: ReadonlyArray<ScatterInstanceReply>): string | undefined {
  const reachable = instances.filter((instance) => instance.reachable);
  const unanswered = reachable.filter((instance) => instance.data === undefined || instance.error !== undefined).length;
  if (reachable.length <= 1 && unanswered === 0) return undefined;
  return `allowlist set is ambiguous: ${reachable.length} reachable manager instances, ${unanswered} without a status reply; pass --on <instance> to select the manager whose allowlist to update`;
}
/** `cotal allowlist set <name>...`: replace the manager's spawn allowlist. It returns once every
 *  launch of a removed name has settled, so a `cotal stop` after it finds any seat that launched. */
export async function allowlist(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof allowlistFlags>;
  const [subcommand, ...names] = args.positionals;
  if (subcommand !== "set") {
    console.error(c.red("usage: cotal allowlist set <name>... [--space <s>] [--server <url>] [--creds <path>] [--on <instance>]"));
    process.exit(1);
  }
  const on = onInstanceOrExit(v.on, "cotal allowlist");
  if (on === undefined) {
    const probe = await resolveControlTarget(v, "control-caller-privileged");
    const status = await scatterManager(probe.space, probe.server, "managerStatus", probe.auth, probe.spaceAuth);
    if (!status.ok) {
      failIfNotOk(status);
      return;
    }
    const ambiguity = allowlistStatusAmbiguity(status.instances);
    if (ambiguity !== undefined) {
      console.error(c.red(`✗ ${ambiguity}`));
      process.exit(1);
    }
  }
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  const reach = t.auth.bearer ? "owner" : "any";
  const request = allowlistSetOptions(on);
  const reply = await askManager(t.space, t.server, "allowlistSet", { names }, t.auth, reach, request.timeoutMs, request.pin);
  failIfNotOk(reply);
  console.log(c.dim(`✓ spawn allowlist set to ${names.length} name${names.length === 1 ? "" : "s"}`));
}
