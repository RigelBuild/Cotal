/**
 * #1554: an `absent` reap outcome must REFUSE, never render as a disposal.
 *
 * `absent` says the custody record could not be read. That is a fact about ADDRESSABILITY, and two
 * of the three ways to reach it leave a LIVE seat: a custodian that dies after `pty.spawn` and
 * before `writeRecord` has a running child and no record, and a stale or wrong reference looks for a
 * record that exists at another path. Both of the manager's rendering sites used to turn that into
 * "already forgotten" and carry on, so an alias could be freed over a seat nobody proved gone.
 *
 * The refusal lives in `requireRuntimeReap` rather than at the callsites: `absent` and `retained`
 * never reach a caller, so no caller can describe either as success.
 *
 * Deliberately broker-free and process-free. The property is about what one function returns versus
 * throws, and the heavy orphan-seat smokes cannot drive a missing record reliably.
 *
 * Run: pnpm smoke:reap-absent-refusal
 */
import { requireRuntimeReap, RuntimeReapUnproven } from "../src/runtime/index.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const reference = { kind: "pty", id: "seat-1554-abcdef" };
// Custodial by duck type (`reserve` + `reap` both functions), which is how isCustodialRuntime
// decides. Nothing else on Runtime is touched by the path under test.
const runtimeWith = (reap: () => Promise<unknown>) =>
  ({ kind: "pty", reserve: () => reference, reap }) as never;

// (a) the refusal itself
let threw: unknown;
let returned: unknown;
try {
  returned = await requireRuntimeReap(runtimeWith(async () => ({ outcome: "absent" })), reference as never);
} catch (e) { threw = e; }
check(
  "#1554: an ABSENT reap outcome REFUSES instead of returning an outcome a caller can render",
  threw !== undefined && returned === undefined,
  { threw: threw === undefined ? null : String(threw), returned },
);
check(
  "#1554: the refusal names the reference, so the operator knows what to go looking for",
  threw !== undefined && String((threw as Error).message).includes(reference.id),
  threw === undefined ? null : String((threw as Error).message),
);
check(
  "#1554: the refusal says the seat is NOT proved gone rather than describing a disposal",
  threw !== undefined && /not proved gone|NOT proved gone/.test(String((threw as Error).message)),
  threw === undefined ? null : String((threw as Error).message),
);

// (b) positive control: a real reap is unaffected
let reaped: unknown; let reapedThrew: unknown;
try {
  reaped = await requireRuntimeReap(
    runtimeWith(async () => ({ outcome: "reaped", detail: "custodian signalled, child gone" })),
    reference as never,
  );
} catch (e) { reapedThrew = e; }
check(
  "CONTROL: a REAPED outcome still returns and carries its detail",
  reapedThrew === undefined && (reaped as { detail?: string } | undefined)?.detail === "custodian signalled, child gone",
  { reapedThrew: reapedThrew === undefined ? null : String(reapedThrew), reaped },
);

// (c) negative control: the pre-existing non-custodial refusal is untouched
let nonCustodialThrew: unknown;
try {
  await requireRuntimeReap({ kind: "tmux" } as never, reference as never);
} catch (e) { nonCustodialThrew = e; }
check(
  "CONTROL: a non-custodial runtime still refuses by name (the older contract is unchanged)",
  nonCustodialThrew !== undefined && String((nonCustodialThrew as Error).message).includes("does not support reap"),
  nonCustodialThrew === undefined ? null : String((nonCustodialThrew as Error).message),
);

// (d) a `retained` outcome refuses too, carrying its reason and the reference. A runtime that read
// the record but could not prove the processes gone has proved nothing more than `absent` did.
let retainedThrew: unknown;
let retainedReturned: unknown;
try {
  retainedReturned = await requireRuntimeReap(
    runtimeWith(async () => ({ outcome: "retained", reason: "unprovable", detail: "no contained cgroup proof; stop requested" })),
    reference as never,
  );
} catch (e) { retainedThrew = e; }
check(
  "RETAINED: an unprovable retained outcome throws RuntimeReapUnproven instead of returning",
  retainedThrew instanceof RuntimeReapUnproven && retainedReturned === undefined,
  { threw: retainedThrew === undefined ? null : String(retainedThrew), retainedReturned },
);
check(
  "RETAINED: the refusal carries reason \"unprovable\" and the exact reference",
  retainedThrew instanceof RuntimeReapUnproven && retainedThrew.reason === "unprovable" &&
    retainedThrew.reference?.kind === reference.kind && retainedThrew.reference.id === reference.id,
  retainedThrew instanceof RuntimeReapUnproven ? { reason: retainedThrew.reason, reference: retainedThrew.reference } : null,
);
check(
  "RETAINED: the refusal message names the reference and keeps the runtime's detail",
  retainedThrew instanceof Error && retainedThrew.message.includes(reference.id) && retainedThrew.message.includes("no contained cgroup proof"),
  retainedThrew instanceof Error ? retainedThrew.message : null,
);
check(
  "#1554: the absent refusal is the same typed error, reason \"absent\"",
  threw instanceof RuntimeReapUnproven && threw.reason === "absent" && threw.reference?.id === reference.id,
  threw instanceof RuntimeReapUnproven ? { reason: threw.reason } : String(threw),
);

console.log(`\nREAP-ABSENT-REFUSAL ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
