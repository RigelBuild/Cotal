import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { loadMeshes, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { askManager, failIfNotOk, onFlag, onInstanceOrExit, resolveControlTarget } from "../lib/control.js";
import { completingFlagValue } from "../lib/completion.js";

export const allowlistFlags = [...targetFlags, onFlag] as const satisfies readonly FlagSpec[];

export function allowlistComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, allowlistFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  if (flag === undefined && argv.length <= 1) return { items: [{ value: "set" }], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
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
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "allowlistSet", { names }, t.auth, reach, undefined, on === undefined ? undefined : { instanceId: on });
  failIfNotOk(reply);
  console.log(c.dim(`✓ spawn allowlist set to ${names.length} name${names.length === 1 ? "" : "s"}`));
}
