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
delegated base. Ordinary stop authority remains Open Question 6 and blocks T1/T2.

### Layer 1 — the custodian keeps the record (`packages/seat`)

- `settleTerminal` stops unlinking `launch.recordPath`. It still disposes the terminal, closes the
  server, unlinks the socket and exits. On all three settle paths (`markExited`, the
  `armUnattended` timer and the `armUnobservedHandoff` timer), `record.json` now outlives the
  custodian. A seat directory is removed only by a `reaped` result or by an operator release.
- `settleTerminal` drops its `proc.kill("SIGKILL")`. Every caller reaches it with `alive` false, so
  the send always targets a leader that has exited. node-pty's `UnixTerminal.kill` is
  `process.kill(this.pid, signal || 'SIGHUP')`, a send to a bare pid.
- `stopChild` must not use `childGone()` as authorization for `proc.kill`: the pid may be reused
  between the check and the signal. A graceful or hard stop may signal through a kernel-pinned
  child handle, preserving its requested signal and grace period. Without one, refuse the
  numeric send and retain custody. `cgroup.kill` belongs to the external reap path only: it is
  immediate SIGKILL and may kill a custodian in that cgroup. Open Question 6 chooses a pinned
  child handle or refusal; neither permits a best-effort bare-pid signal.
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
the custodian to stop through `socketPath(root, id)` only if the custodian has a kernel-pinned child
handle; without either, it sends no signal and returns `retained`. The socket path is derived from
the seat id, never read from `record.json`. A requested stop alone never releases custody.

| Record | Layer 3 | Action | Outcome |
| --- | --- | --- | --- |
| missing | — | none | `absent` (unchanged) |
| unreadable | — | none | throw (retryable, unchanged) |
| present | off, or containment not proved | no numeric signal; optional pinned-handle stop | `retained` / `unprovable` |
| present | on and contained | write `cgroup.kill` | `populated 0` and `rmdir` succeeds → `reaped`; else `retained` / `members-remain` |

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

Without layer 3, a stopped seat remains retained. Ordinary stop behavior depends on Open
Question 6; a custodian without a pinned child handle cannot safely signal node-pty's bare pid.

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
- **Signals.** No signal targets a pid or group number from `record.json`. A contained cgroup may
  be stopped with `cgroup.kill`. Without it, the custodian may stop only through a kernel-pinned
  child handle; otherwise it leaves the process live and returns `retained`.
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

### T1 — the custodian keeps the record (`@cotal-ai/seat`)

**Edits.**

- In `settleTerminal`, delete the `unlinkSync(launch.recordPath)` and exited-leader
  `proc.kill("SIGKILL")` blocks. Replace other bare-pid sends only with a kernel-pinned child
  handle that preserves graceful and hard stop semantics; otherwise refuse the signal and retain
  custody. External reap, not the custodian stop path, uses contained `cgroup.kill`.

**Existing tests.**

- In `packages/seat/smoke/lifecycle.smoke.ts`, the natural-exit cell now asserts that the record
  is present.
- The spawn-action smoke teardown may use `SeatClient.stop("hard")` and `waitExit` only after
  Open Question 6 supplies a kernel-pinned child handle. Otherwise it uses the external reap
  path if contained proof is available, or leaves the retained live seat for explicit operator
  release. The teardown cannot wait for an exit that the stop path refused.
  `implementations/manager/smoke/mutations/spawn-action-seat-reap.json` stays red on both cells.
- `bin/smoke/reap-seat-custodians.mjs` is CI-only tooling that matches the argv run marker. It is
  out of scope.

**New cell.** "unattended settle keeps the custody record". Its mutation, added to
`packages/seat/smoke/mutations/lifecycle.json`, restores the unlink and must turn both
record-present cells red.

### T2 — the reap sends no numeric signal (`@cotal-ai/seat`)

**Edits.**

- In `reapSeat`, delete both `signal(…)` sends and the member loop.
- The existing seat-socket stop may be requested only when the custodian has a kernel-pinned
  child handle; otherwise leave the child live and return `retained`. Use `socketPath(root, id)`,
  never `record.socket`. The pinned-handle interface is part of Open Question 6, not an assumed
  property of node-pty.
- Follow the Approach table: without `opts.cgroup`, the result is always `retained` or `absent`.

**Existing cells that change.**

- The reap-live cells assert `retained`; with a pinned handle the custodian can stop the child,
  otherwise it stays live pending contained-cgroup stop or operator action.
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

**T5 cells.**

- A `setsid` escapee is killed and proved gone.
- A new runtime instance proves the cgroup through the derived path.
- `rmdir` refuses while the cgroup is populated.
- **Migration attempt.** A child tries to write its own pid into `base/cgroup.procs`.
  - Under isolation the write fails, including a group-writable ancestor test, and the reap is
    `reaped` only after the kill.
  - In single-uid mode, or when effective grants cannot be proved absent,
    `seatCgroupContained` is false and the reap is `retained`, never `reaped`.

**T5 mutations.**

- Reading `populated 1` as empty must turn the populated cell red.
- Skipping `seatCgroupContained` must turn the single-uid migration cell red.

**T6 (`@cotal-ai/manager`).** The `CustodialPtyRuntime` constructor takes
`{ cgroupBase?: string; agentUid: number }`. The manager resolves `cgroupBase` at start and logs one
line when it is unavailable.

**T6 cell.** `lifecycle-e2e.smoke.ts` passes all 30 cells only under isolation with verified
containment; a single-uid seat retains custody until explicit release.

## Tasks

- [ ] T1 custodian keeps `record.json`; remove unpinned bare-pid sends; stop teardown requires
      Open Question 6; natural-exit cell and teardown; seat changeset.
- [ ] T2 `reapSeat` sends no record-derived numeric signal; `retained` without contained proof;
      forged-record and setsid cells and mutations; seat changeset.
- [ ] T3 manager: the slot row is the reference authority; a missing reference fails closed;
      `recordRetainedTerminal` on every path; census and fixture updates; manager changeset.
- [ ] T4 release with intent first and a verified operator; seat and manager changesets.
- [ ] T5 contained cgroup proof, seat side; verify delegation and containment; seat changeset.
- [ ] T6 contained cgroup proof, manager side; lifecycle-e2e green only under isolation;
      manager changeset.

## Open Questions

The 2026-10-05 RIG-4546 ruling settled automatic proof, release surface, static-only scope, and
foreign-boot policy. Open Question 6 remains load-bearing for ordinary stop and T1/T2. The
remaining operational choices below need explicit disposition before this record freezes.

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
6. **Custodian stop authority (T1, T2).** Removing unpinned bare-pid sends also affects ordinary
   graceful and hard stops, not just reap. Options:
   - acquire a kernel-pinned per-child handle before exposing the seat socket, and preserve
     SIGTERM/graceful escalation and hard-stop behavior through that handle (recommended);
   - refuse both stop modes without such a handle, retain the live seat, and make teardown use
     external contained reap or operator release. Never wait for an exit after refusal.
   A cgroup kill alone is not a graceful stop and can kill the custodian. No best-effort numeric
   send is assumed. Matt must choose this independently of the decided cgroup proof in Question 1.
7. **Lifecycle scope — decided.** This record covers static lifecycles only. User-mode and hosted
   custodied seats need a separate decision and implementation if brought into scope.
8. **Reboot — decided.** Never release a foreign-boot record automatically. Require explicit
   authenticated operator release; neither directory birth time nor a recorded boot id is proof.
9. **Status shape.** Reuse `refused` (recommended), or add a `retained` disposition to
   `manager-service-contract.ts` and `staticReconciliationStatus`.
10. **Accumulation.** Retained directories collect until someone releases them. Is a count in
    `status` enough, or does this need an alert?
