import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { loadMeshes, resolveControlTarget, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { askManager, scatterManager, type ScatterInstanceReply, type ScatterReply } from "@cotal-ai/workspace/control";
import type { ControlAuth } from "@cotal-ai/workspace";
import { cliControl, failIfNotOk, onFlag, onInstanceId } from "../lib/control.js";
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

export type AllowlistSetRoute = { kind: "pin"; instanceId: string } | { kind: "bearer" } | { kind: "scatter" };

export function allowlistSetRoute(auth: Pick<ControlAuth, "managerInstanceId" | "bearer">): AllowlistSetRoute {
  if (auth.managerInstanceId !== undefined) return { kind: "pin", instanceId: auth.managerInstanceId };
  if (auth.bearer) return { kind: "bearer" };
  return { kind: "scatter" };
}

export type AllowlistSetPreflight =
  | { kind: "pin"; instanceId: string }
  | { kind: "bearer" }
  | { kind: "scatter"; status: ScatterReply };

export async function allowlistSetPreflight(
  auth: Pick<ControlAuth, "managerInstanceId" | "bearer">,
  scatter: () => Promise<ScatterReply>,
): Promise<AllowlistSetPreflight> {
  const route = allowlistSetRoute(auth);
  return route.kind === "scatter" ? { ...route, status: await scatter() } : route;
}

/** A reachable manager with no status data, or an unconfirmed silent instance, cannot prove its allowlist is absent. */
export function allowlistStatusAmbiguity(instances: ReadonlyArray<ScatterInstanceReply>): string | undefined {
  const possiblyLive = instances.filter((instance) => instance.reachable || instance.liveness !== "gone");
  const unanswered = possiblyLive.filter((instance) =>
    !instance.reachable || instance.data === undefined || instance.error !== undefined,
  ).length;
  if (possiblyLive.length <= 1 && unanswered === 0) return undefined;
  return `allowlist set is ambiguous: ${possiblyLive.length} manager instances not confirmed gone, ${unanswered} without a status reply; pass --on <instance> to select the manager whose allowlist to update`;
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
  let target = onInstanceId(v.on, "cotal allowlist");
  if (target === undefined) {
    const probe = await resolveControlTarget(v, "control-caller-privileged");
    const preflight = await allowlistSetPreflight(probe.auth, () =>
      scatterManager(cliControl, probe.space, probe.server, "managerStatus", probe.auth, probe.spaceAuth),
    );
    if (preflight.kind === "pin") {
      target = preflight.instanceId;
    } else if (preflight.kind === "scatter") {
      const status = preflight.status;
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
  }
  const t = await resolveControlTarget(v, "control-caller-admin", target);
  const reach = t.auth.bearer ? "owner" : "any";
  const request = allowlistSetOptions(target);
  const reply = await askManager(cliControl, t.space, t.server, "allowlistSet", { names }, t.auth, reach, request.timeoutMs, request.pin);
  failIfNotOk(reply);
  console.log(c.dim(`✓ spawn allowlist set to ${names.length} name${names.length === 1 ? "" : "s"}`));
}
