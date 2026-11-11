/**
 * A "NOT FOUND" SEAT IS REPORTED ONLY WHEN EVERY REACHABLE INSTANCE ANSWERED FOR ITSELF (#1638).
 *
 * A live deployment, 2026-09-16: `cotal agent stop <seat>` answered "no managed agent on any of the 2 reachable
 * manager instances" twice for a seat a three-call union of `cotal ps` still listed as running; the
 * third stop succeeded. `cotal input --name <seat>` did the same for two seats, and the same command
 * with `--on <instance>` succeeded first time for both. The message is a definite negative that
 * names the instance count, which is the shape a reader believes, so a retry loop reads it as
 * "already gone" and stops looking for a seat that is still running.
 *
 * THE CAUSE IS THE SEARCH, NOT THE WORDING. `locateSeat` filtered the scatter to `reachable` rows
 * and concluded absence from them. But `scatterManager` marks an instance that ANSWERED WITH A
 * REFUSAL as reachable-with-an-error, and a frozen slot that never answered at all is a separate
 * row. Neither stated which seats it hosts. Counting the first as a manager that had looked and
 * found nothing, and ignoring the second, is how an incomplete search became a definite negative.
 *
 * WHAT IS GRADED. `locateSeatIn` is the whole decision as a function of the scatter rows, so the
 * matrix below needs no broker: the defect is in which rows count as evidence of absence, and that
 * is decidable from the rows. The live end-to-end face (a severed manager still hosting the seat,
 * driven through the real binary) is `smoke:cli-seat-locality`'s shape; this suite is the one that
 * can enumerate every row combination, including the ones a live fixture cannot stage reliably.
 *
 * Run: pnpm smoke:seat-locality-honesty   (no broker)
 */
import { deferredSeatIn, deferredSeatLookupFailureMessage, deferredSeatLookupIn, deferredSeatMessage } from "../src/commands/agents.js";
import { allowlistSetOptions, allowlistSetPreflight, allowlistStatusAmbiguity } from "../src/commands/allowlist.js";
import { EP_COMMANDS, locateSeatIn, seatMissRefusal, type SeatLocation, type ScatterInstanceReply, managersByInstance } from "@cotal-ai/workspace/control";
import { managerClusterDocument } from "../../manager/src/manager-service-contract.js";
import { AgentManagerUnsettled, managerChoiceFailure } from "../src/lib/manager-choice.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

const A = "a".repeat(26), B = "b".repeat(26);
/** An instance that ANSWERED with its own roster. */
const answered = (instanceId: string, ...seats: string[]): ScatterInstanceReply =>
  ({ instanceId, reachable: true, data: seats.map((name) => ({ name })) });
/** An instance that answered with a REFUSAL: it is reachable, and it said nothing about its seats. */
const refused = (instanceId: string, error = "unavailable: the contract-store read failed"): ScatterInstanceReply =>
  ({ instanceId, reachable: true, error });
/** A frozen slot that never answered at all. */
const silent = (instanceId: string): ScatterInstanceReply =>
  ({ instanceId, reachable: false, liveness: "unknown" });

console.log("1. the positive control: a complete search still finds, and still reports absence");
{
  check("a seat on one of two answering managers pins to its host",
    locateSeatIn([answered(A, "seat"), answered(B)], "seat").kind === "pin"
    && (locateSeatIn([answered(A, "seat"), answered(B)], "seat") as { instanceId: string }).instanceId === A);
  const both = locateSeatIn([answered(A, "other"), answered(B, "elsewhere")], "seat");
  check("a name on NEITHER of two managers that both answered is absent (a complete search concludes)",
    both.kind === "absent" && both.checked === 2 && both.instances.join() === [A, B].join(), both);
  check("a single answering manager stays unpinned (no ambiguity to resolve)",
    locateSeatIn([answered(A)], "seat").kind === "unpinned");
  // A name two answering managers both run picks neither, rather than the first one asked.
  const twice = locateSeatIn([answered(B, "seat"), answered(A, "seat")], "seat");
  check("a name on BOTH of two answering managers is several, naming each, never a pin",
    twice.kind === "several" && twice.instances.join() === [A, B].join(), twice);
  // A silent manager does not stop a seat found on one that answered from being pinned.
  const beside = locateSeatIn([answered(A), answered(B, "seat"), silent("c".repeat(26))], "seat");
  check("a seat on one answering manager pins to it while another manager is silent",
    beside.kind === "pin" && beside.instanceId === B, beside);
}


console.log("\n5. allowlist-set's multi-manager target and settle deadline");
{
  const status = [answered(A), answered(B)];
  const singleManager = allowlistStatusAmbiguity([answered(A)]);
  const multipleManagers = allowlistStatusAmbiguity(status);
  const noManagers = allowlistStatusAmbiguity([]);
  check("one answering manager keeps the unpinned allowlist path", singleManager === undefined);
  check("two answering managers require an explicit allowlist target", /2 manager instances not confirmed gone/.test(multipleManagers ?? ""));
  check("a refused sibling blocks unpinned allowlist-set", /2 manager instances not confirmed gone, 1 without a status reply/.test(allowlistStatusAmbiguity([answered(A), refused(B)]) ?? ""));
  check("a silent sibling blocks unpinned allowlist-set", /2 manager instances not confirmed gone, 1 without a status reply/.test(allowlistStatusAmbiguity([answered(A), silent(B)]) ?? ""));
  check("a sole reachable manager that refuses status is still ambiguous", /1 manager instances not confirmed gone, 1 without a status reply/.test(allowlistStatusAmbiguity([refused(A)]) ?? ""));
  check("a confirmed-gone sibling does not make one answering manager ambiguous", allowlistStatusAmbiguity([answered(A), { instanceId: B, reachable: false, liveness: "gone" }]) === undefined);
  check("an empty status result preserves the prior anycast path", noManagers === undefined);
  let scatters = 0;
  const scatter = async () => { scatters++; return { ok: true as const, instances: [] }; };
  check("user bearer without --on skips scatter", (await allowlistSetPreflight({ bearer: "user-bearer" }, scatter)).kind === "bearer" && scatters === 0);
  const issuerPin = await allowlistSetPreflight({ managerInstanceId: A }, scatter);
  check("issuer-selected manager pin is used before scatter", issuerPin.kind === "pin" && issuerPin.instanceId === A && scatters === 0);
  const staticCaller = await allowlistSetPreflight({}, scatter);
  check("static unpinned caller scatters", staticCaller.kind === "scatter" && scatters === 1);
  if (staticCaller.kind === "scatter")
    check("no-manager status keeps the prior anycast path", allowlistStatusAmbiguity(staticCaller.status.ok ? staticCaller.status.instances : []) === undefined);
  const pinned = allowlistSetOptions(A);
  const unpinned = allowlistSetOptions(undefined);
  check("allowlist-set waits 120 seconds and retains an explicit instance pin", pinned.timeoutMs === 120_000 && pinned.pin?.instanceId === A);
  check("the single-manager path stays unpinned with the same settle window", unpinned.timeoutMs === 120_000 && unpinned.pin === undefined);
  const commands = managerClusterDocument().commands;
  const missingContracts = Object.entries(EP_COMMANDS).flatMap(([op, mapping]) => {
    const contract = commands.find((row) => row.name === mapping.command);
    return contract === undefined || contract.targeted !== (mapping.targeted === true || mapping.self === true) ? [{ op, mapping, contract: contract?.name, targeted: contract?.targeted }] : [];
  });
  check("every manager op maps to a contract command with matching targeting", missingContracts.length === 0, missingContracts);
  check("CLI allowlistSet and attestGone ops have mappings", EP_COMMANDS.allowlistSet?.command === "allowlist-set" && EP_COMMANDS.attestGone?.command === "attest-gone", { allowlistSet: EP_COMMANDS.allowlistSet, attestGone: EP_COMMANDS.attestGone });
}


console.log("\n2. THE DEFECT: an instance that did not answer FOR ITSELF cannot license absence");
{
  // The live shape: the seat is running on the instance that went silent. Reporting "not found"
  // here is the definite negative the issue measured.
  const s = locateSeatIn([answered(A), silent(B)], "seat");
  check("a silent instance beside an answering one is UNKNOWN, never absent", s.kind === "unknown", s);
  check("...and the unknown names which instance did not answer",
    s.kind === "unknown" && s.silent.includes(B) && s.answered === 1, s);
  // The other half, and the one the old `reachable` filter actively miscounted: an instance that
  // ANSWERED WITH A REFUSAL is reachable and still said nothing about its seats.
  const r = locateSeatIn([answered(A), refused(B)], "seat");
  check("an instance that REFUSED the read is UNKNOWN too: reachable is not the same as answered", r.kind === "unknown", r);
  check("...and it is not counted as a manager that looked and found nothing",
    r.kind === "unknown" && r.answered === 1 && r.refused.some((x) => x.instanceId === B), r);
  const rr = locateSeatIn([refused(A), refused(B)], "seat");
  check("two refusals establish nothing at all: zero answered", rr.kind === "unknown" && rr.answered === 0, rr);
  // A refusal must not mask a positive: the seat is on the manager that DID answer.
  const found = locateSeatIn([answered(A, "seat"), refused(B)], "seat");
  check("a refusal elsewhere never blocks a seat that was positively located",
    found.kind === "pin" && (found as { instanceId: string }).instanceId === A, found);
  // ...and a refusing instance is never itself pinned: it never said it hosts the seat.
  const norefpin = locateSeatIn([answered(A), refused(B)], "seat");
  check("a refusing instance is never pinned as the host (it claimed no seat)",
    norefpin.kind !== "pin", norefpin);
}

console.log("\n3. what the operator is TOLD, which is where the damage landed");
{
  const absent = seatMissRefusal("seat", "cotal stop", { kind: "absent", checked: 2, instances: [A, B] });
  check("a complete search still says the seat is on none of them", absent.startsWith('no managed agent "seat" on any of the 2 reachable'), absent);
  check("...and names the managers that answered", absent.includes(`(${A}, ${B})`), absent);
  const unknown: Extract<SeatLocation, { kind: "unknown" }> = { kind: "unknown", answered: 1, silent: [B], refused: [] };
  const msg = seatMissRefusal("seat", "cotal stop", unknown);
  // THE REGRESSION GUARD. The old sentence is a definite negative and a retry loop believes it.
  check("an incomplete search does NOT say the seat is on none of them", !/no managed agent/.test(msg), msg);
  check("...it says the location could not be established", msg.includes('could not establish where "seat" is'), msg);
  check("...it states outright that this is not a report that the seat is gone",
    msg.includes("NOT a report that it is gone"), msg);
  check("...it names the instance that did not answer, so `--on` is usable", msg.includes(B), msg);
  check("...and names the remedy", msg.includes("--on <instance>"), msg);
  const refusedMsg = seatMissRefusal("seat", "cotal input", { kind: "unknown", answered: 1, silent: [], refused: [{ instanceId: B, error: "the contract-store read failed" }] });
  check("a refusal is reported as a refusal, with the instance and its reason",
    !/no managed agent/.test(refusedMsg) && refusedMsg.includes(B) && refusedMsg.includes("the contract-store read failed"), refusedMsg);
  check("and the remedy names the verb it was called for", refusedMsg.includes("cotal input --on <instance>"), refusedMsg);
  const severalMsg = seatMissRefusal("seat", "cotal attach", { kind: "several", instances: [A, B] });
  check("a name held on several managers says so and names each of them, with the verb's --on",
    severalMsg.startsWith('"seat" is held on each of 2 manager instances') && severalMsg.includes(`(${A}, ${B})`) && severalMsg.includes("cotal attach --on <instance>"), severalMsg);
}
console.log("4. a name held on several managers is a choice among those managers only");
{
  // Neither mesh mode lets two managers start the same name, so this is graded from the rows: the
  // refusal a command without a terminal prints, restated with the command again on each holder.
  const several = { kind: "several" as const, instances: [A, B] };
  const held = new AgentManagerUnsettled('"seat" is held on each of these 2 managers. Which one should run this?', managersByInstance(several.instances), "TARGET_AMBIGUOUS", seatMissRefusal("seat", "cotal stop", several), { agent: "seat" });
  const restated = await managerChoiceFailure(held, async () => { throw new Error("the roster is not read for this refusal"); }, ["stop", "seat", "--json"]);
  check("without a terminal it stays a TARGET_AMBIGUOUS refusal whose Next gives the command again with --on for each holder only",
    restated?.code === "TARGET_AMBIGUOUS" && restated.outcome === "refused" && [A, B].every((id) => restated.remedy?.includes(`stop seat --json --on ${id}`)) && restated.remedy?.split(" or ").length === 2, restated);
}

console.log("5. a plain stop on a deferred seat names the seat's remedy, not absence");
{
  const status = (instanceId: string, failures: unknown[]): ScatterInstanceReply =>
    ({ instanceId, reachable: true, data: { staticReconciliation: { failures } } });
  const remedy = "the seat is unreachable and its credential has not expired; it terminalizes after deferUntil, or confirm its processes are gone and run cotal stop <alias> --attest-gone <reason>";
  const holder = deferredSeatIn([status(A, [{ alias: "other", disposition: "deferred", lifecycleUid: "u0", remedy }]), status(B, [{ alias: "seat", disposition: "deferred", lifecycleUid: "u1", deferUntil: "2026-11-05T00:00:00.000Z", remedy }])], "seat");
  check("two instances: attest-gone without --on pins to the instance that holds the alias deferred, not the first",
    holder?.instanceId === B && holder.lifecycleUid === "u1" && holder.deferUntil === "2026-11-05T00:00:00.000Z", holder);
  const msg = holder === undefined ? "" : deferredSeatMessage("seat", holder);
  check("the plain-stop refusal names the instance, uid, deferUntil and the pinned --on attest-gone command",
    msg.includes(B) && msg.includes("u1") && msg.includes("2026-11-05T00:00:00.000Z") && msg.includes(`--on ${B} --attest-gone`), msg);
  check("a non-deferred item for the same alias yields nothing, so attest-gone fails with the no-holder message",
    deferredSeatIn([status(A, [{ alias: "seat", disposition: "refused", lifecycleUid: "u1", remedy }])], "seat") === undefined);
  const failedLookup = deferredSeatLookupIn({ ok: false, error: "no manager replies" }, "seat");
  const failedScatterMessage = failedLookup.kind === "found"
    ? "unexpected found deferred seat"
    : deferredSeatLookupFailureMessage("seat", failedLookup);
  check("a failed status scatter stays unreachable and says managers could not be asked, never that none reports the deferred seat",
    failedLookup.kind === "unreachable"
    && failedScatterMessage === "✗ could not ask the managers in this space (no manager replies); pass --on <instance>"
    && !failedScatterMessage.includes("no manager instance in this space reports"), failedScatterMessage);
}
// DECLARED, not implied: a suite that ends early reddens no line, and `fail === 0` with a zero exit
// reads as a pass in every one of those ways out. The count is checked however the process leaves.
const EXPECTED_CELLS = 37;
process.on("exit", () => {
  const ran = pass + fail;
  if (ran !== EXPECTED_CELLS) {
    console.error(`\nSUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    process.exitCode = 1;
  }
});
console.log(`\nseat-locality-honesty: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
