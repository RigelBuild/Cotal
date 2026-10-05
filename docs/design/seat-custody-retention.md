# Seat custody retention after leader exit

## Problem / Intent

A custodied seat's child is a session and process-group leader. When that leader exits, nothing
proves its process group empty, but the cleanup paths act as if something did:

- `settleTerminal` in `packages/seat/src/custodian.ts` unlinks `record.json` once the child has
  exited. `reapSeat` in `packages/seat/src/reap.ts` then returns `absent`, which `requireRuntimeReap`
  refuses. If the record survived, `reapSeat` skips the group, because `groupKilled` is false once
  the leader is gone.
- After a group kill, the `reapSeat` member loop SIGKILLs pids that a `/proc` census found. That
  census runs after the leader exited, so a pid may already belong to another process.
- `reapOrphanSeat` in `implementations/manager/src/manager.ts` returns without a reap when no
  reference reaches it, and the cleanup runs anyway.
- Under signer isolation, every pid that `reapSeat` trusts comes from a file the agent can write.

RIG-4320 ruled option 1: custody evidence lives until the terminal reap. RIG-4422 provisionally chose
fail-closed retention, which has three rules:

- no numeric process-group signal without kernel-backed proof;
- no custody or credential deletion while descendants are not proved gone;
- a static name may stay blocked until an operator repairs it.

This record turns that decision into interfaces, failure behavior and regression cells.

## Approach

Layers 1 and 2 implement RIG-4422 and work without layer 3. Layer 3 restores automatic cleanup and
is gated on Open Question 1. The scope is static lifecycles under the custodial pty runtime. Open
Question 6 covers user-mode and hosted lifecycles.

### Layer 1 — the custodian keeps the record (`packages/seat`)

- `settleTerminal` stops unlinking `launch.recordPath`. It still disposes the terminal, closes the
  server, unlinks the socket and exits. `record.json` outlives the custodian on all three settle
  paths (`markExited`, the `armUnattended` timer and the `armUnobservedHandoff` timer). Only a
  `reaped` result or an operator release removes a seat directory.
- `settleTerminal` drops its `proc.kill("SIGKILL")`. Every caller reaches it with `alive` false, so
  the send always targets an exited leader. node-pty's `UnixTerminal.kill` is
  `process.kill(this.pid, signal || 'SIGHUP')`, which sends to a bare pid.
- Residue: `stopChild` and the other `proc.kill` sends in `custodian.ts` check only `alive`. That
  flag can lag node-pty's native reap until the `childGone()` poll notices. T1 adds a `childGone()`
  check before each send. This makes the window smaller; it does not close it.
- `record.json` keeps `RECORD_VERSION` 1. `readRecord` in `packages/seat/src/record.ts` stays
  strict, so no older reader starts refusing records.

### Layer 2 — what the reap may trust (`packages/seat`)

`reapSeat` gains a third outcome, `retained`, and never removes the seat directory when it returns
it. Five trust rules apply.

1. **The uid check.** At send time, every pid the reap signals must have a live start identity and
   a real uid equal to `expectedUid`. The real uid is the first field of the `Uid:` line in
   `/proc/<pid>/status`. `expectedUid` comes from the caller and never from `record.json`: it is
   the manager's own uid without isolation and the `cotal-agent` uid with it. If the start identity
   is live but the uid differs, the record is forged. The reap then signals nothing and returns
   `retained` / `untrusted-record`. In `docs/design/signer-isolation.md`, `record.json` is
   `0640 cotal-agent:cotal-manager` and is written by the dropped custodian. Hop 8 there states
   that "`kill(2)` across a uid boundary is `EPERM`". So the only process a forged pid can make the
   manager kill is one that runs as the manager's own uid, and this check refuses exactly that
   case.
2. **Isolation removes census proof.** When `expectedUid !== process.getuid()`, a census over
   record pids proves nothing, because the agent can name a decoy group that it leads. In that
   case `reaped` needs the layer 3 proof. Without it, the reap returns `retained` / `unprovable`.
3. **What the census counts.** It counts every task whose pgrp **or** session id (fields 5 and 6
   of `/proc/<pid>/stat`) is the group number `N`.
   - It is proof only after a SIGKILL reached group `N` while the verified leader held `N`.
   - Under the tasklist lock, `copy_process` in `kernel/fork.c` aborts a fork when
     `fatal_signal_pending(current)` ("Let kill terminate clone/fork in the middle"). So the group
     cannot gain members, and `N` cannot be reused while any member lives.
   - A member that called `setpgid` stays in the session, so counting the session catches it.
   - A census taken at any other time proves nothing.
4. **`/proc` must show every process.** A census returns `unprovable` when the manager's `/proc`
   mount (`/proc/self/mountinfo`) carries a `hidepid` value other than `0`, because tasks of other
   uids would be invisible to it.
5. **The existing numeric sends.** `kill(-childPid)` and the custodian `kill(pid)` stay as they are
   today, and this record does not call them safe. Between the identity check and the send, the
   leader can exit and be reaped, and its number can then lead a new group. Open Question 5
   decides. The layer 3 cgroup option removes both sends.

| Record | State at reap | Signal | Proof | Outcome |
| --- | --- | --- | --- | --- |
| missing | — | none | — | `absent` (unchanged) |
| unreadable | — | none | — | throw (retryable, unchanged) |
| no start identity, no boot id, or foreign boot | — | none | — | `retained` / `unprovable` (today: throw) |
| live identity, wrong uid | — | none | — | `retained` / `untrusted-record` |
| present, not isolated | child live and leads `N` | `kill(-N)` SIGKILL (today) | census of `N` empty | `reaped`, else `members-remain` |
| present, not isolated | child gone; this runtime delivered a SIGKILL to `N` | none | census of `N` empty | `reaped`, else `members-remain` |
| present | any other case | none to the group | — | `retained` / `unprovable` |
| present, layer 3 cgroup | any | `cgroup.kill` | `populated 0`, then `rmdir` succeeds | `reaped`, else `members-remain` |

`CustodialPtyRuntime` keeps `killedGroups: Map<string, number>`, keyed by seat id, for the groups it
SIGKILLed under rule 3. A `members-remain` retry can then count again instead of falling to
`unprovable`. A manager restart loses this map, so the successor gets `unprovable`.

```ts
// packages/seat/src/reap.ts (re-exported from packages/seat/src/index.ts)
export type SeatRetainReason = "unprovable" | "members-remain" | "untrusted-record";
export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; custodian: "signalled" | "gone"; child: "signalled" | "gone"; group: number; detail: string }
  | { outcome: "retained"; reason: SeatRetainReason; childPid: number; census?: number; detail: string };
export interface SeatReapOpts { graceMs?: number; expectedUid: number; killedGroup?: number; cgroup?: SeatCgroup }
export async function reapSeat(root: string, id: string, opts: SeatReapOpts): Promise<SeatReapEvidence>;

// implementations/manager/src/runtime/index.ts
export type RuntimeUnprovenReason = "absent" | "no-reference" | "unprovable" | "members-remain" | "untrusted-record";
export type RuntimeReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: "unprovable" | "members-remain" | "untrusted-record"; detail: string };
export class RuntimeReapUnproven extends Error {
  readonly reference: RuntimeReference | undefined;
  readonly reason: RuntimeUnprovenReason;
  constructor(runtimeKind: string, reference: RuntimeReference | undefined, reason: RuntimeUnprovenReason, detail?: string);
}
```

`requireRuntimeReap` keeps its signature. It throws `RuntimeReapUnproven` for both `absent` and
`retained`, so its two callers (`spawnCustodied` and `reapOrphanSeat`) stay fail-closed.
`spawnCustodied` reads `e.reference.kind` today; it changes to read `got`, which is defined at that
point. `census` is text for the operator and is never used to signal.

### Layer 2 — the manager keeps the lifecycle standing

**The slot row is the reference authority.** `reapOrphanSeat` returns today when it gets no
reference:

```ts
if (a.runtime === undefined) { if (isCustodialRuntime(this.runtime)) console.error(…); return; }
```

`reapThenCleanup` then runs `await cleanup()`. After this change:

- Inside the executor of `driveStaticRetirement`, `slot.row.runtime` is the reference. A reference
  that a caller passes is only a cross-check; if the two differ, the terminal throws.
- If the runtime is custodial and no row reference exists, `reapOrphanSeat` throws
  `RuntimeReapUnproven(kind, undefined, "no-reference")`. This includes the no-slot-row
  (pre-Unit-B) path.

No call site can open this path again by forgetting a reference. The rollback `deprovision` in the
auth preflight passes `userOwner`, so it takes the non-static branch and runs before any seat
exists. It is out of scope.

**On `RuntimeReapUnproven` the manager:**

- leaves the slot `terminalizing` and `cleanupComplete` unset;
- keeps the alias in `retiring`, so `writeStaticSlotIntent` refuses the name;
- skips the `cleanup` closure: issuance retirement, the creds file, broker durables and the ACL.
  Open Question 4 decides whether revocation and eviction may run first;
- never writes "restart this manager" in a remedy or NEXT, because a restart cannot prove a group
  empty.

**Status is visible on every path.** Today only `reconcileStaticLifecycles` fills
`staticReconcileItems`. A live despawn's failure lands only on the `retiring` hold's `lastError`,
which `staticReconciliationStatus` never reads, so the common graceful-stop case is hidden until the
next boot.

- A new `recordRetainedTerminal` writes the item for every `RuntimeReapUnproven` caught in the
  `driveStaticRetirement` catch block. It is the only writer of that item.
- For `members-remain` it keeps the existing retry timer.
- For every other reason it sets `refused`, the release remedy and no timer, because no new
  evidence can arrive.

**Exit signals do not release custody.** `SeatClient.waitExit`, `helloInfo.status === "exited"` and
`status() === "exited"` on a handle mean that the leader exited. None of them releases custody.

### Operator release

A release records that the operator accepts the risk. It is not a proof and it never signals.

- **Refusal.** It refuses in any of these cases:
  - a live custodian or child identity;
  - a census of `N` that is not empty;
  - a `hidepid` mount;
  - under layer 3, `populated 1`.
- **Effect.** It writes a release record, removes the seat directory and re-drives the terminal. In
  that terminal, the release record satisfies the process step.
- **Where the attestation is stored.** Under the recommendation for Open Question 4, the retained
  terminal has already written its `v: 1` lifecycle audit in `evictAndAudit`. `sameAudit` in
  `static-lifecycle.ts` compares every field, including `v`, so the attestation cannot go into that
  audit. The recommended shape is a separate create-only release record. The alternative is a
  `v: 2` audit with a `release` field, which needs `sameAudit` to accept a v1-to-v2 rewrite.
  Open Question 2 decides the shape and the surface.

### Layer 3 — kernel-backed proof (gated on Open Question 1)

Without layer 3, every graceful stop is retained. The custodian stops the child and node-pty reaps
it before `driveStaticRetirement` runs; this is the lifecycle-e2e `opStop` race.

**Recommended: a per-seat cgroup v2 domain.**

- **Path.** The path is `<base>/seat-<id>`. `base` is the manager's own delegated cgroup: the
  `0::<path>` line of `/proc/self/cgroup`, under `/sys/fs/cgroup`. The manager derives the path and
  never reads it from `record.json`.
- **Entry.**
  - Without isolation, `launchSeat` creates the directory. The custodian writes its own pid to
    `cgroup.procs` before `pty.spawn`, so the child and every descendant start inside it.
  - With isolation, `cotal-seat-launch` creates the directory and moves the forked process in
    before `setuid`. The agent cannot write the base `cgroup.procs`, so it cannot leave.
- **Proof and kill.** Proof is `populated 0` in `cgroup.events`, and then `rmdir` succeeds. An
  `rmdir` fails with `EBUSY` while any task remains. The kill is a write of `1` to `cgroup.kill`.
- **Benefits.**
  - It survives a manager restart, because the path is derived.
  - It covers `setsid` escapees.
  - It removes every numeric signal.
  - It needs no native code.
  - The agent cannot forge it.
- **Costs.**
  - It needs the cgroup v2 unified hierarchy and `cgroup.kill` (Linux 5.14).
  - The manager unit needs `Delegate=yes`.
  - Development and smoke runs need `systemd-run --user --scope -p Delegate=yes`.
  - Without a delegated base, layer 3 is off and layer 2 applies. It never falls back to a numeric
    signal.
- **Measured.** On this host the kernel is `7.2.6`, `/sys/fs/cgroup` is `cgroup2fs`, and this
  session runs in a systemd user scope. The CI runner and the fleet are not measured.
- **Not verified; T5 checks.** [INFERENCE] With `subtree_control` empty, the no-internal-process
  rule does not stop a seat cgroup from existing under the manager's own cgroup. A `cgroup.kill`
  write signals across uids on file permission alone.

**Alternative: a manager-held pidfd group handle.** It uses `PIDFD_SIGNAL_PROCESS_GROUP` (Linux
6.9).

- **Mechanics (from kernel source).** `do_pidfd_send_signal` maps the flag to `PIDTYPE_PGID` and
  calls `kill_pgrp_info` on the pinned `struct pid`. `__kill_pgrp_info` returns `-ESRCH` only when
  no task is in the group. It returns `EPERM` when tasks exist but none can be signalled, so a
  signal-0 probe proves emptiness across uids; only the kill needs the helper.
- **Weaknesses.**
  - Older kernels reject the flag with `EINVAL`, because `pidfd_send_signal` checks
    `flags & ~PIDFD_SEND_SIGNAL_FLAGS`.
  - The handle dies with the manager.
  - `setsid` escapees are outside the group.
  - It needs native code.
  - A launcher-held trusted pid anchor fails in the same restart case and gives less.

## Plan

### Global Constraints

- **Scope.** Static lifecycles (`!this.userMode && !a.userOwner` in `driveDeprovision`) under the
  custodial pty runtime, Linux only.
- **Signals.** No new numeric signal. The two existing identity-checked sends in `reapSeat` are not
  presumed safe (Open Question 5). The census never signals.
- **Record trust.** No field of `record.json` alone authorizes a signal or a `reaped` verdict. The
  uid check always applies. Under isolation, `reaped` needs the layer 3 proof.
- **Deletion.** Nothing is deleted before a `reaped` result or a release: not the seat directory,
  the creds file, issuance retirement, durables or ACL rows. Revocation and eviction follow Open
  Question 4.
- **Schemas.** `record.json` stays at `RECORD_VERSION` 1. There is no new slot-row field; the
  closed row schema in `packages/core/src/lifecycle-state.ts` is unchanged.
- **Fallback.** Layer 3 never falls back to a numeric signal.
- **Remedy text.** No remedy or NEXT for a retained seat says "restart this manager".
- **Changesets.** Every implementation task ships a `.changeset/*.md` (`"@cotal-ai/seat": patch`
  or `"@cotal-ai/manager": patch`, then one prose paragraph). This record needs none.
- **Claims.** Every implementation PR names the file and function behind each claim about current
  behavior.

### T1 — the custodian keeps the record (`@cotal-ai/seat`)

**Edits.** In `settleTerminal`, delete the `unlinkSync(launch.recordPath)` block and the
`proc.kill("SIGKILL")` block. Add a `childGone()` check before each remaining `proc.kill`.

**Interfaces.** No signature changes. After the custodian exits, `<root>/<id>/record.json` stays
until a `reaped` result or a release removes it.

**Existing tests that change:**

- In `packages/seat/smoke/lifecycle.smoke.ts`, "natural exit: custodian process, socket, and
  record converge…" now asserts that the record is **present**.
- The spawn-action smoke teardown and `bin/smoke/reap-seat-custodians.mjs` remove their own
  directory when the result is `retained` with `census` 0. A census above 0 fails "teardown: no
  live seat is left behind". `implementations/manager/smoke/mutations/spawn-action-seat-reap.json`
  stays red on both of its cells.

**New cells.** "unattended settle keeps the custody record", using a short `UNATTENDED_MS`. Add a
mutation to `packages/seat/smoke/mutations/lifecycle.json` that restores the unlink. Both
record-present cells must turn red under it.

### T2 — reap trust (`@cotal-ai/seat`)

**Interfaces.** Use `SeatReapOpts`, `SeatRetainReason` and `SeatReapEvidence` from Approach. Add
two helpers in `reap.ts`:

- `censusOf(n: number): number`, which counts tasks by pgrp or session;
- `procHidden(mountinfo = "/proc/self/mountinfo"): boolean`.

`expectedUid` is required. Every caller passes it: `CustodialPtyRuntime.reap`, the smokes and the
sweeper, which pass `process.getuid()` without isolation.

**Behavior.** Follow the Approach table:

- The member loop counts and never signals.
- The no-identity, no-boot and foreign-boot cases return `retained` instead of throwing.
- An unreadable record still throws.
- Any existing cell that asserts one of those three throws now asserts the `retained` result and
  that no signal was sent.

**Cells:**

- The reap-live cells stay unchanged and green.
- "leader gone, grandchild alive → `unprovable`, grandchild not signalled, record kept".
- "`expectedUid` differs on a live identity → `untrusted-record`, target untouched". The test runs
  a real process of its own and passes `process.getuid() + 1`.
- "a `setpgid` escapee is still counted by session".
- "`killedGroup` recount proves an emptied group".
- "foreign boot → `retained`, not a throw".
- "a `hidepid=invisible` mountinfo fixture → `unprovable`".

**Mutations.** Each must turn its cell red:

- put the member-loop SIGKILL back;
- return `reaped` when the child is gone;
- drop the uid check;
- count by pgrp only.

### T3 — the manager stands fail-closed (`@cotal-ai/manager`)

**Interfaces:**

- In `runtime/index.ts`: `RuntimeReapUnproven`, `RuntimeUnprovenReason` and `RuntimeReapEvidence`,
  as given in Approach.
- `CustodialPtyRuntime.reap` maps the seat outcomes one-to-one and keeps `killedGroups`.
- `private async reapOrphanSeat(a: { name: string; runtime?: RuntimeReference },`
  `rowRuntime: RuntimeReference | undefined): Promise<void>`.
  The row's reference wins. A mismatch throws. If neither reference exists under a custodial
  runtime, it throws `no-reference`.
- `private recordRetainedTerminal(row: Pick<StaticManagedSlotRow,`
  `"owner" | "alias" | "actor" | "lifecycleUid">, e: RuntimeReapUnproven): void`.
  The `driveStaticRetirement` catch block calls it. After it runs, the catch block in
  `attemptStaticReconcile` schedules a retry only for `members-remain`.

**Cells:**

- In `implementations/manager/smoke/reap-absent-refusal.smoke.ts` section (d), keep "expected 2"
  callsites of `requireRuntimeReap(`. Add "no site renders a retained outcome as prose (expected
  0)".
- Use a fake custodial runtime that returns `retained` / `unprovable`. Check that:
  - the slot stays `terminalizing`;
  - the footprint remains;
  - `writeStaticSlotIntent` throws `failed-precondition`;
  - on the **live** despawn path, `status` shows `refused` with the release remedy and no
    `nextRetryAt`.
- A slot row with no `runtime` under a custodial runtime gives `refused` / `no-reference`, and the
  creds file remains.
- In `orphan-seat-reap.mutations.json`, update the find text to the new `reapOrphanSeat` call in
  the same commit.
- `lifecycle-e2e.smoke.ts`: see Open Question 3.

### T4 — operator release (`@cotal-ai/seat`, `@cotal-ai/manager`; Open Question 2)

```ts
// packages/seat/src/reap.ts
export type SeatReleaseResult =
  | { outcome: "released"; census: number; detail: string }
  | { outcome: "refused"; reason: "live-identity" | "members-remain" | "census-hidden" | "populated"; detail: string };
export function releaseSeatCustody(root: string, id: string, opts: { expectedUid: number; cgroup?: SeatCgroup }): SeatReleaseResult;

// implementations/manager/src/static-lifecycle.ts (recommended shape)
export interface StaticLifecycleReleaseSpec {
  v: 1; principal: string; alias: string; lifecycleUid: string;
  operator: string; reason: string; census: number; managerInstance: string; timestamp: string;
}
export async function writeStaticRelease(t: LifecycleStateTransport, spec: StaticLifecycleReleaseSpec): Promise<void>; // create-only; a same-spec retry is a no-op
export async function readStaticRelease(t: LifecycleStateTransport, owner: string, actor: string, lifecycleUid: string): Promise<StaticLifecycleReleaseSpec | undefined>;

// implementations/manager/src/manager.ts
interface OperatorRelease { operator: string; reason: string }
private async releaseRetainedSeat(alias: string, release: OperatorRelease): Promise<void>;
```

**Flow.** `releaseRetainedSeat`:

1. reads the slot, which must be `terminalizing` and owned by this instance;
2. calls `releaseSeatCustody`;
3. writes the release record;
4. re-drives the terminal.

Inside the executor, a `readStaticRelease` hit for this lifecycle satisfies the process step, so a
retry after a crash needs no second release.

**Cells:**

- The release refuses with a live grandchild.
- The release refuses under the `hidepid` fixture.
- The release frees the alias and the footprint, and the record names the operator.
- A crash after the record is written finishes on retry.

### T5 / T6 — automatic proof (Open Question 1; the tasks below are for option (a))

**T5 (`@cotal-ai/seat`):**

```ts
// packages/seat/src/cgroup.ts
export interface SeatCgroup { readonly path: string }
export function seatCgroupPath(base: string, id: string): string;     // `${base}/seat-${id}`
export function createSeatCgroup(base: string, id: string): SeatCgroup; // throws by name if base is not delegated cgroup2
export function joinSeatCgroup(cg: SeatCgroup): void;                   // custodian, before pty.spawn
export function seatCgroupPopulated(cg: SeatCgroup): boolean;           // parses cgroup.events
export function killSeatCgroup(cg: SeatCgroup): void;                   // writes "1" to cgroup.kill
export function removeSeatCgroup(cg: SeatCgroup): void;                 // rmdir; EBUSY throws
```

`LaunchSeatOpts` gains `cgroupBase?: string`, and `CustodianLaunch` gains `cgroup?: string`.
`reapSeat` with `opts.cgroup` uses the last row of the Approach table only.

**T5 cells:**

- a `setsid` escapee is killed and proved gone;
- a new `CustodialPtyRuntime` instance proves the group through the derived path;
- `rmdir` refuses while the cgroup is populated.

Mutation: read `populated 1` as empty. The cells must turn red.

**T6 (`@cotal-ai/manager`).** The `CustodialPtyRuntime` constructor takes `{ cgroupBase?: string }`.
At start, the manager reads `/proc/self/cgroup` and checks that `cgroup.procs` in the base is
writable. If it is not, the option is `undefined` and the manager logs one line. The runtime passes
`cgroup` to `reapSeat`. Under isolation, the helper's launch request carries the path.

**T6 cell.** `lifecycle-e2e.smoke.ts` under `systemd-run --user --scope -p Delegate=yes` passes all
30 cells.

**If Matt picks option (b), T5 and T6 change:**

- `pidfdOpen` and `pidfdSendSignal` go into the existing `peercred.c` addon, so no second binary is
  needed. Add an `#ifndef PIDFD_SIGNAL_PROCESS_GROUP` fallback define and check its value against
  `include/uapi/linux/pidfd.h`.
- Add a `SeatGroup` and an `openSeatGroup` that verifies the identity, uid and `pgid === pid` after
  the open.
- `CustodialPtyRuntime` keeps a `Map<string, SeatGroup>`.

## Tasks

- [ ] T1 custodian keeps `record.json`; drop the post-exit `proc.kill`; add `childGone()` guards;
      update the natural-exit cell, spawn-action teardown and sweeper; seat changeset.
- [ ] T2 `reapSeat` trust rules and `retained` outcome; uid check; census by pgrp and session;
      `hidepid` refusal; the boot and identity throws become `retained`; cells and mutations; seat
      changeset.
- [ ] T3 manager: the slot row is the reference authority; missing reference fails closed;
      `recordRetainedTerminal` on every path; `refused` disposition; census and fixture updates;
      manager changeset.
- [ ] T4 operator release and release record (after Open Question 2); seat and manager changesets.
- [ ] T5 automatic proof, seat side (after Open Question 1); seat changeset.
- [ ] T6 automatic proof, manager side; lifecycle-e2e green (after Open Question 1); manager
      changeset.

## Open Questions

Each question is load-bearing: the named task cannot start until Matt rules on it.

1. **Automatic proof (T5, T6).**
   - Options: (a) a per-seat cgroup v2 domain (recommended); (b) a manager-held pidfd group handle;
     (c) none, which means accepting a blocked name and a release after every graceful stop.
   - To decide, Matt needs the kernel version, cgroup mode and delegation on the CI runner and the
     fleet. Only this host is measured.
2. **Release surface and record shape (T4).**
   - Surface: a local-only control verb on the live manager (recommended; it reuses the manager's
     executor and single-flight), or a CLI. The CLI would hold signer authority and run
     `runStaticTerminal` itself, with a single-flight against the manager.
   - Shape: a separate create-only release record (recommended), or a `v: 2` lifecycle audit with a
     v1-to-v2 rule in `sameAudit`.
3. **lifecycle-e2e while T5 and T6 are pending.** T1–T3 alone turn the cells "w2 … gone after
   explicit stop" red and keep the four "… gone after despawn" cells red. Options:
   - land T1–T3 and T5–T6 as one stack (recommended);
   - land T1–T3 alone, with the cause of those red cells stated in the PR. `rule://no-inert-gating`
     bars changing the cells to make them pass.
4. **Revocation before proof.** `runStaticTerminal` runs `revokeStaticCredentialRows` and
   `evictAndAudit` before `cleanupStaticSlotOnce`. Options: let revocation and eviction run and hold
   back only deletion (recommended; it cuts a surviving descendant's broker access); or hold the
   whole terminal.
5. **The existing numeric sends in `reapSeat`** (`kill(-childPid)` and the custodian `kill(pid)`).
   This record chooses no default. Options:
   - keep them, with today's window;
   - remove them, so that every reap without layer 3 is retained;
   - replace them with layer 3 where it exists, and choose (i) or (ii) for hosts without it.
6. **Lifecycles out of scope.** In `driveDeprovision`, the user-mode branch and the
   `remoteAuthority` branch delete credentials and never call `reapOrphanSeat`. Does RIG-4422
   cover them? If not, the static-only scope above stands.
7. **Reboot** (security-sensitive; no default). A foreign boot proves that every process of that
   boot is gone. Options:
   - never release automatically (today);
   - trust the per-seat directory's `statx` birth time against boot time. Under isolation the agent
     cannot recreate the directory. This needs filesystem birth-time support and a clock margin;
   - have the manager record the boot id, which needs a slot-row field.
8. **Status shape.** Reuse `refused` with the release remedy (recommended; no contract change), or
   add a `retained` disposition to `manager-service-contract.ts` and to
   `staticReconciliationStatus`.
9. **Retained directories over time.** They accumulate under `~/.cotal/seats` or
   `/var/lib/cotal/seats` until a release. Is a count in `status` enough, or is an alert needed?
