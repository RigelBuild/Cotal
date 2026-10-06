# Seat custody retention after leader exit

## Problem / Intent

A custodied seat's child is a session and process-group leader. When that leader exits, nothing
proves the seat's processes gone, but the cleanup paths act as if something did:

- `settleTerminal` in `packages/seat/src/custodian.ts` unlinks `record.json` once the child exits.
  After that, `reapSeat` in `packages/seat/src/reap.ts` returns `absent`, and `requireRuntimeReap`
  refuses it. If the record survived, `reapSeat` skips the group: `groupKilled` is false once the
  leader is gone.
- After a group kill, the `reapSeat` member loop SIGKILLs every pid that a `/proc` census finds.
  That census runs after the leader has exited, so a found pid may already belong to another
  process.
- `reapOrphanSeat` in `implementations/manager/src/manager.ts` returns without a reap when no
  reference reaches it, and the cleanup runs anyway.
- The agent's uid can write `record.json` in every mode. Without isolation, `writeRecord` in
  `packages/seat/src/record.ts` writes it `0600` as the shared uid. With isolation, the dropped
  custodian writes it `0640 cotal-agent:cotal-manager` (`docs/design/signer-isolation.md`). So no
  pid, start token or boot id in the record is authentic.

RIG-4320 ruled option 1: custody evidence lives until the terminal reap. RIG-4422 provisionally
chose fail-closed retention, with three rules:

- no numeric process-group signal without kernel-backed proof;
- no custody or credential deletion while descendants are not proved gone;
- a static name may stay blocked until an operator repairs it.

This record turns that decision into interfaces, failure behavior and regression cells.

## Approach

Layers 1 and 2 implement RIG-4422. Matt selected a contained per-seat cgroup v2 domain for
layer 3, a privileged manager release verb, static-only scope, and no automatic foreign-boot
release (RIG-4546, 2026-10-05). Single-uid seats fail closed because an agent can escape the
delegated base. For ordinary stop, Matt selected a kernel-pinned handle to the exact spawned child
(RIG-4546 Option 1), captured by the native PTY spawn before its exit thread can reap that child
(RIG-4687 Option A). Every graceful, escalated or hard stop signals through that handle.

### Layer 1 — the custodian keeps the record (`packages/seat`)

- `settleTerminal` stops unlinking `launch.recordPath`. It still disposes the terminal, closes the
  server, unlinks the socket and exits. On all three settle paths (`markExited`, the
  `armUnattended` timer and the `armUnobservedHandoff` timer), `record.json` now outlives the
  custodian. A seat directory is removed only by a `reaped` result or by an operator release.
- `settleTerminal` drops its `proc.kill("SIGKILL")`. Every caller reaches it with `alive` false, so
  the send always targets a leader that has exited. node-pty's `UnixTerminal.kill` is
  `process.kill(this.pid, signal || 'SIGHUP')`, a send to a bare pid.
- **The custodian pins its exact child before it exposes the seat socket.** The native PTY spawn
  obtains a handle for the child returned with its pid, before node-pty's exit thread can reap it.
  T1 patches the pinned node-pty spawn path; a post-spawn `pidfd_open` is not a substitute. Pinning
  completes before the startup-confirm timer is armed and before `listening.listen` binds
  `launch.socket`. After the child exits, a send through the handle reports it gone and reaches no
  other process. Like `proc.kill` today, the handle covers the child only; descendants are layer
  3's concern. The handle lives in custodian memory, not in `record.json` or the seat protocol.
- **A pid read after `pty.spawn` is not evidence.** In node-pty's `src/unix/pty.cc`, `PtyFork`
  calls `forkpty` and then `SetupExitCallback`, whose thread blocks in
  `waitpid(pid, &stat_loc, 0)`. A child that exits at once can be reaped, and its pid reused,
  before `pty.spawn` returns to JavaScript. `pidfd_open(2)` guarantees that an open after `fork`
  names the child only if "the zombie process was not reaped elsewhere in the program (e.g., …
  by wait(2) or similar in another thread)". Checking that the opened process is live and that
  its parent is the custodian does not repair this. With `CLONE_PARENT`, a seat process can
  create a process whose parent "will be the same as that of the calling process" (clone(2)).
  So a process with the custodian as its parent can take the freed pid, and a send through that
  handle stops the wrong process. T1 must prove spawn-time capture against this race.
  [INFERENCE: T1 confirms] This source is microsoft/node-pty `main`, which
  `@lydell/node-pty` repackages; T1 checks it against the pinned `1.2.0-beta.12`.
- **Identities are read before the spawn.** Today `runCustodian` reads
  `processStartToken(process.pid)` and `bootToken()` after `pty.spawn`. They move before it, so a
  missing custodian start identity fails with no child. `childStart` is read after acquisition.
  It is kept only if the handle still reports the child live after the read; otherwise the record
  omits it, as it does today for a child that is already gone.
- **Every child signal goes through the handle, with today's semantics.** `stopChild("graceful")`
  sends SIGTERM, then SIGKILL after `GRACE_MS` if the child is still `alive`.
  `stopChild("hard")` sends SIGKILL. The startup-confirm timeout, the `armUnattended` stop and
  every startup failure use the same handle. No path calls node-pty's `proc.kill`, or
  `proc.destroy`, whose close handler calls `this.kill('SIGHUP')`. `childGone()` still drives
  `markExited`, but it never authorizes a signal.
- **A startup failure after acquisition stops the child.** From acquisition until `ready`, every
  failure sends SIGKILL through the handle before `runCustodian` rejects. This covers a throw in
  `runCustodian`, a throw in the `listening.listen` callback, and the listen `error` event. Today
  `listening.once("error", reject)` rejects with no send at all. The send does not wait on
  `alive`, because a handle on an exited child reaches no process. The custodian then exits
  through the `runCustodian` catch, so `launchSeat` throws `custodian exited before ready:
  <cause>`.
- **A launcher timeout is not a disappearance proof.** `launchSeat` currently stops waiting after
  ten seconds and throws while its detached custodian may still be starting. T1 must reserve the
  same custody ID, observe the custodian through its handle or a durable launch result, and leave
  the seat retained if absence cannot be proved. No timeout frees a static name or removes the
  seat directory. A late record cannot make the timed-out launch look absent.
- **A missing handle fails closed.** If pinning fails, or its evidence proves neither that the
  handle names the spawned child nor that the child is gone, the custodian sends the child no
  signal. It does not bind its socket, write `record.json` or become ready. It logs the
  cause to `custodian.log` and exits through the `runCustodian` catch, so `launchSeat` throws
  `custodian exited before ready: <cause>`. A missing custodian start identity exits the same
  way, before any child exists. Without a contained seat cgroup, a reap of the reserved
  reference then returns `absent`, which stays fail-closed, so the name stays held until a
  verified release. With one, the reap kills and proves the cgroup without the record (Layer 2).
  [INFERENCE: T1 verifies] The custodian's exit closes the PTY master, and the kernel then hangs
  up the child's terminal. That hangup is not a send to a pid.
- **A fast exit is not an acquisition failure.** The "natural exit" and "unadopted" cells launch
  children that exit at once, and they must keep launching. A handle captured at spawn stays
  valid after the child exits and reports it gone. The custodian then marks the child exited and
  sends nothing. Only a handle that might name another process fails closed.
- **The stop reply covers only the first send.** `case "stop"` sends `{ ok: true, op: "stop" }`
  as soon as `stopChild` returns. So the reply reports the SIGTERM of a graceful stop or the
  SIGKILL of a hard stop. If that send fails for any reason except "child gone", the reply is
  `{ ok: false, error }`. The graceful SIGKILL runs `GRACE_MS` after the reply. If it fails, the
  custodian logs the failure to `custodian.log`, and the child stays `alive`. A pending
  `wait-exit` then stays pending, and the caller's own bound reports it, for example
  `awaitHandleExit` in `manager.ts` ("child did not exit within …"). `SeatClient.stop` throws an
  immediate error. `SeatHandle.stop` discards it today through `later`'s
  `.catch(() => undefined)`, so a manager caller sees any stop failure only as a child that does
  not exit. No failure is read as an exit, and no send is retried by pid.
- `cgroup.kill` belongs to the external reap path only. It is immediate SIGKILL, it is not a
  graceful stop, and it may kill a custodian in that cgroup.
- `record.json` keeps `RECORD_VERSION` 1, and `readRecord` stays strict.

### Layer 2 — the reap trusts nothing in the record (`packages/seat`)

`reapSeat` gains a third outcome, `retained`. Without layer 3 it sends no signal and never returns
`reaped`. Two facts force this:

- **A forged record can aim any numeric send.** An agent can write a live same-uid pid and its
  start token, which anyone can read from `/proc/<pid>/stat`. A uid check cannot tell that pid from
  the seat's own, because without isolation the manager, the custodian and the agent share one uid.
  So the identity-checked `kill(-childPid)` and `kill(custodianPid)` that run today are removed.
  The decision text bars the group send directly. The single-pid send is barred by the same forgery.
- **A census cannot prove a process tree gone.** A descendant that calls `setsid()` leaves both
  the recorded process group and the session. After the group dies, a census of pgrp or session `N`
  can be empty while that descendant still runs. No census result is proof. A census appears only
  as advisory text that is labelled as not proof.

When a contained cgroup exists, reap stops its tasks through `cgroup.kill`. Otherwise it may ask
the custodian to stop through `socketPath(root, id)`. A real custodian binds that socket only
after it holds its pinned child handle (Layer 1), so the custodian, not the reap, sends the
signal. With no custodian answering, the reap sends no signal. Either way the result is
`retained`. The socket path is derived from the seat id, never read from `record.json`. A
requested stop alone never releases custody.

The seat cgroup path is derived too, so the reap checks it before it reads `record.json`. A
custodian that dies before `writeRecord`, or an agent that deletes the record, can leave a
populated cgroup with no record. Reading the record first would return `absent` and strand
those tasks. When the derived cgroup exists and is contained, it decides the outcome whether the
record is present, missing or unreadable.

| Record | Layer 3 | Action | Outcome |
| --- | --- | --- | --- |
| missing | off, not contained, or no seat cgroup | none | `absent` (unchanged) |
| unreadable | off, not contained, or no seat cgroup | none | throw (retryable, unchanged) |
| present | off, not contained, or no seat cgroup | no numeric signal; optional stop request to the custodian | `retained` / `unprovable` |
| any | seat cgroup exists and is contained | write `cgroup.kill` | `populated 0` and `rmdir` succeeds → `reaped`; else `retained` / `members-remain` |

The missing-identity, missing-boot-id and foreign-boot throws in `reapSeat` become
`retained` / `unprovable`, because no new evidence can arrive for them.

```ts
// packages/seat/src/reap.ts (re-exported from packages/seat/src/index.ts)
export type SeatRetainReason = "unprovable" | "members-remain";
export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: SeatRetainReason; stop: "requested" | "no-custodian" | "timeout"; detail: string };
export interface SeatReapOpts { graceMs?: number; cgroup?: SeatCgroup }
export async function reapSeat(root: string, id: string, opts?: SeatReapOpts): Promise<SeatReapEvidence>;

// implementations/manager/src/runtime/index.ts
export type RuntimeUnprovenReason = "absent" | "no-reference" | "unprovable" | "members-remain";
export type RuntimeReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: "unprovable" | "members-remain"; detail: string };
export class RuntimeReapUnproven extends Error {
  readonly reference: RuntimeReference | undefined;
  readonly reason: RuntimeUnprovenReason;
  constructor(runtimeKind: string, reference: RuntimeReference | undefined, reason: RuntimeUnprovenReason, detail?: string);
}
```

`reaped` no longer carries `custodian`, `child` or `group`. Those fields described numeric sends,
which no longer happen. `requireRuntimeReap` keeps its signature and throws `RuntimeReapUnproven`
for both `absent` and `retained`. Its two callers, `spawnCustodied` and `reapOrphanSeat`, therefore
stay fail-closed. `spawnCustodied` reads `e.reference.kind` today; it changes to read `got`, which
is defined at that point.

### Layer 2 — the manager keeps the lifecycle standing

**The slot row is the reference authority.** Today `reapOrphanSeat` returns early when no reference
reaches it (`if (a.runtime === undefined) { …; return; }`), and `reapThenCleanup` then runs
`await cleanup()`. After this change:

- Inside the executor of `driveStaticRetirement`, the reference is `slot.row.runtime`. A reference
  that a caller passes is only a cross-check, and a mismatch throws.
- With a custodial runtime and no row reference, `reapOrphanSeat` throws
  `RuntimeReapUnproven(kind, undefined, "no-reference")`. This includes the path where no slot row
  exists. The rollback `deprovision` in the auth preflight passes `userOwner`, takes the non-static
  branch and runs before any seat exists, so it is out of scope.

**On `RuntimeReapUnproven` the manager:**

- leaves the slot `terminalizing` and `cleanupComplete` unset;
- keeps the alias in `retiring`, so `writeStaticSlotIntent` refuses the name;
- skips the `cleanup` closure: issuance retirement, the creds file, the broker durables and the
  ACL. Open Question 5 decides whether revocation and eviction may run first;
- never puts "restart this manager" in a remedy or NEXT.

**Status is visible on every path.** Today only `reconcileStaticLifecycles` fills
`staticReconcileItems`. A live despawn's failure reaches only the `lastError` of its `retiring`
hold, and `staticReconciliationStatus` never reads that field. A new `recordRetainedTerminal`
fixes this:

- The `driveStaticRetirement` catch block calls it for every `RuntimeReapUnproven`. It is the only
  writer of that item.
- For `members-remain` it keeps the existing retry timer. The cgroup path is derived, so a retry
  can measure again, even after a restart.
- For every other reason it sets `refused`, gives the release remedy and arms no timer.

**Exit signals do not release custody.** `SeatClient.waitExit`, `helloInfo.status === "exited"`
and a handle's `status() === "exited"` all mean that the leader exited. None of them releases
custody.

### Operator release

A release is an operator's attestation. It is not a proof, and it never sends a signal. Four rules
apply.

1. **The operator is the verified caller.** The request carries no operator field. On a manager
   verb, the recorded operator is the subject caller: `ctx.subject.caller` (`owner`, `actor`,
   `uid`), the same tuple that `callerOf` keys on. The verb is admitted through `adminGated`, like
   `purge` and the resume family under the `manager.admin` capability. `epAdminReach` documents the
   one residual: in a static mesh, reaching the handler is the admin tier, so "a LEAKED static
   admin instrument keeps its reach until the credential's bounded TTL". Matt selected this
   manager verb rather than a separate CLI (RIG-4546).
2. **It pins one incarnation.** The input is `{ alias, lifecycleUid, reason }`, with
   `additionalProperties: false`. The slot must be `terminalizing`, at that `lifecycleUid`, and
   owned by this manager instance.
3. **It writes the intent before any deletion.**
   1. Run the read-only checks. Under layer 3 the release refuses when `populated 1`.
   2. Read the existing release record for this lifecycle. If present, compare the stable fields
      (principal, alias, lifecycle UID, authenticated operator, reason and manager instance), reuse
      its timestamp and continue; reject a different intent. Otherwise create it atomically.
      A concurrent create loser rereads and compares the stored intent before deleting anything.
   3. Remove the seat directory. `ENOENT` counts as success.
   4. Re-drive the terminal.

   In the terminal, a release record for this lifecycle satisfies the process step. If the seat
   directory is still present, the process step removes it first. A crash at any point resumes
   from the durable record. A failure before the record is written deletes nothing. An `absent`
   record without a release record stays refused.
4. **The attestation does not go into the lifecycle audit.** `evictAndAudit` already writes the
   `v: 1` lifecycle audit, and `sameAudit` in `static-lifecycle.ts` compares every field. The
   release record remains separate so a retry can compare the authenticated operator and stable
   intent before any deletion.

### Layer 3 — contained kernel-backed proof

Without layer 3, a stopped seat remains retained. An ordinary stop still exits the child through
the custodian's pinned handle (Layer 1), but an exited leader proves nothing about its
descendants.

**Chosen: a per-seat cgroup v2 domain.** It is proof only if the agent cannot leave it.

- **Path.** `<base>/seat-<id>`. `base` is the manager's delegated cgroup: the `0::<path>` line of
  `/proc/self/cgroup`, under `/sys/fs/cgroup`. The path is derived, never read from `record.json`.
- **Entry.** Without isolation, `launchSeat` creates the directory and the custodian joins it
  before `pty.spawn`. With isolation, `cotal-seat-launch` creates the directory owned by
  `cotal-manager` and moves the forked process into it before `setuid`.
- **Containment.** Cgroup v2 migration requires write access to the common ancestor's
  `cgroup.procs` (kernel `admin-guide/cgroup-v2`). `seatCgroupContained` must prove the agent cannot
  write that file at the base or any ancestor using its actual uid, primary and supplementary
  groups, ACLs and effective capabilities. An owner/mode check alone is not proof. Provision a
  controlled migration attempt under the agent's credentials; if it succeeds or any grant cannot
  be verified, return `retained`. Under isolation the manager-owned base can pass this check;
  without isolation the shared manager/agent uid can write the base, so it fails. Open Question 2
  decides the single-uid policy. No proof depends on the agent's claimed identity.
- **Proof and kill.** The kill is a write of `1` to `cgroup.kill` (Linux 5.14). The proof is
  `populated 0` in `cgroup.events` followed by a successful `rmdir`; `rmdir` fails with `EBUSY`
  while any task remains. A `setsid` escapee stays in the cgroup, so it is covered.
- **Survives restart.** The path is derived, so a successor manager can measure and kill.
- **Costs.**
  - It needs cgroup v2 and a delegated base (`Delegate=yes` on the manager unit).
  - Smoke runs need `systemd-run --user --scope -p Delegate=yes`.
  - Without a delegated base, layer 3 is off. It never falls back to a numeric signal.
- **Measured here only.** Kernel `7.2.6`, `/sys/fs/cgroup` is `cgroup2fs`, inside a systemd user
  scope.
- **For T5 to verify.** [INFERENCE] A seat cgroup can sit under `base` when `subtree_control` is
  empty. A write to `cgroup.kill` signals across uids on file permission alone.

**Alternative: a pidfd group handle** (`PIDFD_SIGNAL_PROCESS_GROUP`, Linux 6.9).

- In `kernel/signal.c`, `do_pidfd_send_signal` maps the flag to `PIDTYPE_PGID`.
  `__kill_pgrp_info` returns `-ESRCH` only for an empty group.
- It still needs a pid that the agent cannot forge, and the record does not supply one.
- It misses `setsid` escapees, dies with the manager, and needs native code.

## Plan

### Global Constraints

- **Scope.** Static lifecycles (`!this.userMode && !a.userOwner` in `driveDeprovision`) under the
  custodial pty runtime. Linux only.
- **Signals.** No signal targets a pid or group number from `record.json`. The reap may stop a
  contained cgroup with `cgroup.kill` and sends no other signal. The custodian signals its child
  only through its kernel-pinned child handle, captured by the native PTY spawn before the child
  can be reaped. A parent and liveness check is not that evidence. The custodian never calls
  node-pty's `proc.kill` or `proc.destroy`. A custodian that cannot pin the handle never exposes
  its socket. A startup failure after pinning sends SIGKILL through the handle.
- **Proof.** `reaped` comes only from layer 3 when `seatCgroupContained` holds. A census is never
  proof.
- **Deletion.** No seat directory, creds file, issuance retirement, durable or ACL row is deleted
  before `reaped` or a durable release record exists. Revocation and eviction follow Open
  Question 5.
- **Schemas.** `record.json` stays at version 1. No new slot-row field is added; the closed row
  schema in `packages/core/src/lifecycle-state.ts` is unchanged.
- **Release identity.** The release operator comes from a verified caller, never from the request
  payload.
- **Remedies.** No remedy or NEXT for a retained seat says "restart this manager".
- **Changesets.** Every implementation task ships a `.changeset/*.md` (`"@cotal-ai/seat": patch`
  or `"@cotal-ai/manager": patch`, then one prose paragraph). This record needs none.
- **Evidence.** Every implementation PR names the file and the function behind each claim about
  current behavior.

### T1 — the custodian keeps the record and pins its child (`@cotal-ai/seat`)

**Interfaces.** No exported shape changes: `StopMode`, the `stop` op, `SeatClient.stop`,
`SeatHandle.stop`, `CustodianLaunch` and `SeatRecord` keep their current shapes. The pinned child
handle is internal to `runCustodian` and meets the Layer 1 contract. The patched native PTY spawn
returns it with the spawned child before the exit thread starts. It replaces node-pty's `proc.kill`
as the only signal path.

**Edits.**

- In `settleTerminal`, delete the `unlinkSync(launch.recordPath)` and exited-leader
  `proc.kill("SIGKILL")` blocks.
- In `runCustodian`, move the `processStartToken(process.pid)` and `bootToken()` reads before
  `pty.spawn`. Read `childStart` after acquisition, under the Layer 1 rule.
- Take the pinned child handle returned by the patched native PTY spawn. Never open one by pid after
  `pty.spawn` returns. On failure, apply the Layer 1 fail-closed rule. A child proved already gone
  is marked exited; that is not a failure.
- From acquisition until `ready`, send SIGKILL through the handle on every startup failure,
  including the listen `error` event.
- Send every child signal through the handle. `stopChild`, the startup-confirm timeout and the
  `armUnattended` stop keep today's signals and `GRACE_MS` escalation. Remove every remaining
  `proc.kill` call, and call no `proc.destroy`. External reap, not the custodian stop path, uses
  contained `cgroup.kill`.
- Reply to `stop` with the result of the first send only. Log a failed escalation to
  `custodian.log`.

**Existing tests.**

- In `packages/seat/smoke/lifecycle.smoke.ts`, the natural-exit cell now asserts that the record
  is present. "graceful stop: waitForExit resolves" and "hard stop: child is gone after
  waitForExit" stay green through the handle. So does "O1 its child goes with it" in
  `packages/seat/smoke/orphan.smoke.ts`, which exercises the `armUnattended` stop.
- The spawn-action smoke teardown stops each remaining seat through `SeatClient`
  (`stop("hard")`, then `waitExit`, then `close`), so its custodian sends SIGKILL through the
  handle and then settles. A seat whose custodian has already settled has no socket and skips the
  stop. The teardown then removes the seat directories, because without layer 3 `reapSeat` never
  returns `reaped`. Update the find texts in
  `implementations/manager/smoke/mutations/spawn-action-seat-reap.json` in the same commit; both
  of its mutations must still turn their cells red.
- `bin/smoke/reap-seat-custodians.mjs` is CI-only tooling that matches the argv run marker. It is
  out of scope.

**New cells.** Each mutation goes in `packages/seat/smoke/mutations/lifecycle.json`.

- **Unattended settle keeps the custody record.** Its mutation restores the unlink and must turn
  both record-present cells red.
- **Graceful stop escalates.** The child ignores SIGTERM. After `stop({ graceful: true })`,
  `waitForExit` resolves and the child is gone. Its mutation removes the escalation timer and
  must turn this cell red.
- **An unpinned child is never signalled.** The cell forces acquisition to fail through a
  test-only seam that T1 adds with its mechanism; a production launch cannot set it. The child
  writes its pid to a test file, ignores SIGHUP and writes a marker file on SIGTERM. `launchSeat`
  throws with the logged cause, neither `seat.sock` nor `record.json` exists, and the child is
  alive with no marker. The test then kills the child by that pid. Its mutation adds a
  `proc.kill("SIGKILL")` fallback on acquisition failure and must turn this cell red.
- **Startup failures after pinning stop the child.** One cell forces the listen `error` event
  before bind. Another fails after bind but before `writeRecord`, once the test's pid file exists.
  In both, the child ignores SIGHUP and SIGTERM, `launchSeat` throws with the logged cause,
  `record.json` does not exist, and the child is gone. Removing either SIGKILL path turns its cell
  red.
- **A reused pid is never signalled.** The test runs `launchSeat` inside a fresh user and pid
  namespace, where a write to `ns_last_pid` steers the next pid. The child is a small C
  fixture. It creates a sibling with `CLONE_PARENT`, writes its pid to a test file and exits at
  once. After node-pty reaps the child, the sibling sets the next pid to the child's pid and
  creates a second `CLONE_PARENT` process, which takes that pid with the custodian as its
  parent. The T1 test seam holds the custodian after `pty.spawn` until that process exists, then
  forces the startup failure. `launchSeat` throws, and the process at the reused pid is alive.
  Tearing down the namespace kills the rest. Its mutation opens the handle by pid after the
  hold, with parent and liveness checks, and must turn this cell red. Measured here only: under
  `unshare --user --map-root-user --pid --fork --mount-proc`, a write of 41 to `ns_last_pid`
  gave the next process pid 42 (kernel `7.2.6`). [INFERENCE: T1 verifies] CI runners allow
  unprivileged user namespaces.
- **Late readiness after the launcher bound.** Hold the custodian before record creation past the
  ten-second launcher deadline. The timed-out launch keeps the reserved ID and static name; a
  subsequent record or socket cannot turn it into an absent seat. Release needs contained proof
  or the verified operator path, not a PID observation.

### T2 — the reap sends no numeric signal (`@cotal-ai/seat`)

**Edits.**

- In `reapSeat`, delete both `signal(…)` sends and the member loop.
- The reap may request the existing seat-socket stop through `socketPath(root, id)`, never
  `record.socket`. The custodian sends the signal through its pinned handle (T1); the reap sends
  none. With no custodian answering, leave the child live.
- Follow the Approach table: without `opts.cgroup`, the result is always `retained` or `absent`.

**Existing cells that change.**

- The reap-live cells assert `retained` with `stop: "requested"`. The custodian exits the child
  through its pinned handle, and the reap proves nothing about the grandchild.
  "the custody record is forgotten" becomes "the custody record is kept".
- The cell for a mismatched start identity now asserts `retained`.

**New cells.**

- **Forged same-uid record.** The test starts its own sleeper, writes the sleeper's pid and start
  token into the record as the child and the custodian, and reaps. The sleeper is still alive, and
  the outcome is `retained`.
- **setsid escapee.** A child spawns a `setsid` grandchild, writes the grandchild's pid to a test
  file and exits. The outcome is `retained`, never `reaped`, and the grandchild is alive. The test
  then kills the grandchild by that pid.
- **Foreign boot.** The outcome is `retained`, not a throw.

**Mutations.** Each must turn the named cell red:

- adding back `kill(-childPid)` turns the forged-record cell red;
- returning `reaped` when a census finds an empty pgrp or session turns the setsid cell red.

### T3 — the manager stands fail-closed (`@cotal-ai/manager`)

**Interfaces.**

- `RuntimeReapUnproven`, `RuntimeUnprovenReason` and `RuntimeReapEvidence`, as given in Approach.
- `CustodialPtyRuntime.reap` maps one-to-one.
- `private async reapOrphanSeat(a: { name: string; runtime?: RuntimeReference },`
  `rowRuntime: RuntimeReference | undefined): Promise<void>`.
  The row's reference wins, and a mismatch throws. With a custodial runtime and neither reference
  present, it throws `no-reference`.
- `private recordRetainedTerminal(row: Pick<StaticManagedSlotRow,`
  `"owner" | "alias" | "actor" | "lifecycleUid">, e: RuntimeReapUnproven): void`.
  The `driveStaticRetirement` catch block calls it. The catch block in `attemptStaticReconcile`
  then schedules a retry only for `members-remain`.

**Cells.**

- **Census section.** `implementations/manager/smoke/reap-absent-refusal.smoke.ts` section (d)
  keeps "expected 2" `requireRuntimeReap(` callsites. Add "no site renders a retained outcome as
  prose (expected 0)".
- **Retained terminal.** Use a fake custodial runtime that returns `retained` / `unprovable`.
  Assert:
  - the slot stays `terminalizing`;
  - the footprint remains;
  - `writeStaticSlotIntent` throws `failed-precondition`;
  - on the live despawn path, `status` shows `refused` with the release remedy and no
    `nextRetryAt`.
- **No reference.** A slot row with no `runtime` under a custodial runtime gives `refused` /
  `no-reference`, and the creds file remains.
- **Fixture.** Update the find text in `orphan-seat-reap.mutations.json` in the same commit.

### T4 — operator release (`@cotal-ai/seat`, `@cotal-ai/manager`)

Use the selected privileged manager verb.

```ts
// packages/seat/src/reap.ts
export type SeatReleaseCheck = { ok: true; advisory: string } | { ok: false; reason: "populated"; detail: string };
export function checkSeatRelease(root: string, id: string, opts?: { cgroup?: SeatCgroup }): SeatReleaseCheck; // read-only
export function removeSeatCustody(root: string, id: string): void; // idempotent; ENOENT is success

// implementations/manager/src/static-lifecycle.ts
export interface StaticLifecycleReleaseSpec {
  v: 1; principal: string; alias: string; lifecycleUid: string;
  operator: { owner: string; actor: string; uid: string }; // from ctx.subject.caller, never args
  reason: string; managerInstance: string; timestamp: string;
}
export async function writeStaticRelease(t: LifecycleStateTransport, spec: StaticLifecycleReleaseSpec): Promise<void>; // atomic create-only; compare stored stable fields on conflict
export async function readStaticRelease(t: LifecycleStateTransport, owner: string, actor: string, lifecycleUid: string): Promise<StaticLifecycleReleaseSpec | undefined>;

// implementations/manager/src/manager-service-contract.ts
// { name: "release-seat", capability: "manager.admin", input: RELEASE_SEAT_INPUT_SCHEMA, … handler: "releaseSeat" }
// RELEASE_SEAT_INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["alias", "lifecycleUid", "reason"], … }

// implementations/manager/src/manager.ts
// releaseSeat: (ctx) => this.serveGated(ctx, () => adminGated(ctx, async () => unwrap(await this.opReleaseSeat(args(ctx), ctx.subject.caller))))
private async opReleaseSeat(args: Record<string, unknown>, caller: EpCaller): Promise<ControlReply>;
```

**Cells.**

- **Authorization.** A user-mode caller without `admin` gets `permission-denied`, and no record is
  written.
- **Operator from the payload.** A request with an `operator` field is rejected by the input
  schema. The recorded operator equals the caller tuple.
- **Wrong incarnation.** A `lifecycleUid` mismatch is refused.
- **Store failure.** If writing the release record fails, the seat directory and the footprint
  remain.
- **Crash after the record is written.** A crash before `removeSeatCustody` finishes on retry.
- **Retry with a fresh timestamp.** A second invocation by the same operator and reason reuses
  the durable intent and finishes; a different reason or operator is rejected without deletion.
- **Concurrent release.** A loser of atomic create compares the winner's stable fields before
  removing custody; different intents never share authorization.
- **Crash during the terminal.** A crash after removal, before the terminal ends, finishes on
  retry.
- **Refusal.** Under layer 3, a populated cgroup is refused.

### T5 / T6 — contained automatic proof (chosen cgroup v2 domain)

**T5 (`@cotal-ai/seat`).**

```ts
// packages/seat/src/cgroup.ts
export interface SeatCgroup { readonly path: string; readonly agentUid: number }
export function seatCgroupPath(base: string, id: string): string;            // `${base}/seat-${id}`
export function createSeatCgroup(base: string, id: string, agentUid: number): SeatCgroup;
export function joinSeatCgroup(cg: SeatCgroup): void;                        // custodian, before pty.spawn
export function seatCgroupContained(cg: SeatCgroup): boolean;                // includes uid, groups, ACLs, capabilities and a migration probe
export function seatCgroupPopulated(cg: SeatCgroup): boolean;                // cgroup.events
export function killSeatCgroup(cg: SeatCgroup): void;                        // "1" > cgroup.kill
export function removeSeatCgroup(cg: SeatCgroup): void;                      // rmdir; EBUSY throws
```

`LaunchSeatOpts` gains `cgroupBase?: string`, and `CustodianLaunch` gains `cgroup?: string`.
`reapSeat` checks whether `opts.cgroup.path` exists before it reads `record.json`, following the
Layer 2 table.

**T5 cells.**

- A `setsid` escapee is killed and proved gone.
- A new runtime instance proves the cgroup through the derived path.
- `rmdir` refuses while the cgroup is populated.
- **Migration attempt.** A child tries to write its own pid into `base/cgroup.procs`.
  - Under isolation the write fails, including a group-writable ancestor test, and the reap is
    `reaped` only after the kill.
  - In single-uid mode, or when effective grants cannot be proved absent,
    `seatCgroupContained` is false and the reap is `retained`, never `reaped`.
- **Record-less seat.** A contained seat's child ignores SIGTERM and SIGHUP. The test deletes
  `record.json`, as an agent or a custodian that died before `writeRecord` would leave it, and
  reaps. The outcome is `reaped`, the child is gone and the cgroup directory is removed.

**T5 mutations.**

- Reading `populated 1` as empty must turn the populated cell red.
- Skipping `seatCgroupContained` must turn the single-uid migration cell red.
- Reading `record.json` before the cgroup, so a missing record returns `absent`, must turn the
  record-less cell red.

**T6 (`@cotal-ai/manager`).** The `CustodialPtyRuntime` constructor takes
`{ cgroupBase?: string; agentUid: number }`. The manager resolves `cgroupBase` at start and logs one
line when it is unavailable. `CustodialPtyRuntime.reap` passes the derived `cgroup` on every
reap, so a reference whose record is missing still reaches its seat cgroup.

**T6 cell.** `lifecycle-e2e.smoke.ts` passes all 30 cells only under isolation with verified
containment; a single-uid seat retains custody until explicit release. This requires a delegated
cgroup v2 base whose parent controls the agent UID cannot write. CI must provision that base and
the distinct UID before running the cell; absent privileges report a retained outcome, not a
passing contained-proof assertion.

## Tasks

- [ ] T1 custodian keeps `record.json`; identities before the spawn; exact-child handle captured
      in the native PTY spawn before reaping, then returned with the child; every stop and startup
      failure through it; fail closed without it; natural-exit, escalation, unpinned-child,
      startup-failure, reused-pid and teardown cells; seat changeset.
- [ ] T2 `reapSeat` sends no record-derived numeric signal; stop only by request to the
      custodian; `retained` without contained proof; forged-record and setsid cells and
      mutations; seat changeset.
- [ ] T3 manager: the slot row is the reference authority; a missing reference fails closed;
      `recordRetainedTerminal` on every path; census and fixture updates; manager changeset.
- [ ] T4 release with intent first and a verified operator; seat and manager changesets.
- [ ] T5 contained cgroup proof, seat side; the cgroup decides before the record; verify
      delegation and containment; record-less cell; seat changeset.
- [ ] T6 contained cgroup proof, manager side; lifecycle-e2e green only under isolation;
      manager changeset.

## Open Questions

The 2026-10-05 RIG-4546 ruling settled automatic proof, release surface, static-only scope, and
foreign-boot policy. RIG-4546 Option 1 settled custodian stop authority. RIG-4687 chose Option A:
capture the exact-child handle in the native PTY spawn, before the exit thread can reap the child.
Questions 4, 5, 9 and 10 remain operational choices requiring disposition before freeze.

1. **Automatic proof — decided.** Use a contained per-seat cgroup v2 domain. The manager must
   measure kernel version, delegation and cgroup mode on CI and the fleet before relying on it;
   unavailable proof returns `retained`, never a numeric-signal fallback.
2. **Single-uid mode — decided.** Without isolation the agent can write the base
   `cgroup.procs` and leave its cgroup. `seatCgroupContained` is false; each reap returns
   `retained` until a verified operator release. No weaker accidental-leak proof is accepted.
3. **Release — decided.** Use an `adminGated` manager verb whose operator is the subject caller
   and a separate durable release record. The v1 lifecycle audit remains unchanged.
4. **lifecycle-e2e while T5 and T6 are pending.** T1–T3 alone turn the cells "w2 … gone after
   explicit stop" red and keep the four "… gone after despawn" cells red. After T6, those cells
   pass only under isolation with verified containment. Options:
   - land T1–T3 and T5–T6 as one stack (recommended);
   - land T1–T3 with the red cells and their cause stated in the PR. `rule://no-inert-gating`
     bars changing the cells.
5. **Revocation before proof.** `runStaticTerminal` runs `revokeStaticCredentialRows` and
   `evictAndAudit` before `cleanupStaticSlotOnce`. Options:
   - let them run and hold back only deletion (recommended);
   - hold the whole terminal.
6. **Custodian stop authority — decided (RIG-4546 Option 1).** The custodian acquires a
   kernel-pinned per-child handle before it exposes the seat socket. Graceful stop (SIGTERM, then
   SIGKILL after `GRACE_MS`), hard stop (SIGKILL), the startup-confirm timeout, the unattended
   stop and startup failures all signal through it; no path sends to a bare pid. Acquisition
   failure fails closed: no signal, no socket, no record. A reap of the reserved reference stays
   fail-closed unless a contained seat cgroup proves it. `cgroup.kill` stays reap-only. Refusing
   both stop modes without a handle was not chosen. The handle names the exact spawned child and
   is captured during the native PTY spawn (RIG-4687 Option A).
7. **Lifecycle scope — decided.** This record covers static lifecycles only. User-mode and hosted
   custodied seats need a separate decision and implementation if brought into scope.
8. **Reboot — decided.** Never release a foreign-boot record automatically. Require explicit
   authenticated operator release; neither directory birth time nor a recorded boot id is proof.
9. **Status shape.** Reuse `refused` (recommended), or add a `retained` disposition to
   `manager-service-contract.ts` and `staticReconciliationStatus`.
10. **Accumulation.** Retained directories collect until someone releases them. Is a count in
    `status` enough, or does this need an alert?
11. **Exact-child capture — decided (RIG-4687 Option A).** The native PTY spawn captures a
    kernel-pinned handle for the spawned child before node-pty's exit thread can reap it, then
    returns the handle with the pid. T1 patches the pinned node-pty implementation and verifies
    the returned handle names that child; upgrades must preserve the patch. The alternative,
    opening by pid after `pty.spawn` and checking parent and liveness, is invalid: a seat process
    created with `CLONE_PARENT` can take the reaped child's pid and appear to have the custodian
    as its parent. T1's reused-pid cell must keep that unrelated process alive.
