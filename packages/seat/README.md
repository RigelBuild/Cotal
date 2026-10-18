# @cotal-ai/seat

Local PTY seat custody: a one-shot launcher, one detached custodian process per seat, and the
authenticated local protocol a manager worker uses to adopt that handle.

**Tier:** `packages/` (leaf). Depends on PTY and terminal-mirror libraries, not on
`@cotal-ai/core`, workspace, implementations, connectors, or NATS. The manager's `pty` runtime
is the first production caller.

Linux is the production transport in this cut. `create`/`spawn`/`adopt` in this package throw a
named `custody transport unsupported on <platform>` error on darwin and win32. There is no
in-process node-pty fallback here. The manager's `pty` runtime still spawns in-process off
Linux and only `adopt` throws that named error.

`peerCredentials(socket)` and its `PeerCredentials` type are exported from the package root.
For a connected Linux Unix socket, the function returns the kernel's peer `pid`, `uid` and
`gid` using the same `SO_PEERCRED` helper as custody. Callers must compare that identity
against their own authorization policy; a PID is not a lifecycle or ownership fence. It
throws for an unsupported transport or missing native helper, and for a socket without a
file descriptor. No PTY or custodian is started by reading the peer identity.

The custodian raises its child's `oom_score_adj` to 500 and writes one line to `custodian.log`
when the kernel refuses.

The Linux natives are compiled for the host arch by `pnpm build`: the `SO_PEERCRED` helper
`peercred.node` and `pty.node`, built from the vendored `node-pty@1.2.0-beta.12` source in
`native/node-pty/` plus `pidfd.patch`, which opens a pidfd for each forked child. That is a
developer tree, not a publishable one: it prints a host-dev-build banner and writes
`build/Release/linux-<arch>/`. Pack and publish require both `linux-x64` (ELF e_machine 62) and
`linux-arm64` (ELF e_machine 183) directories, copied in by `scripts/seat-assemble-natives.mjs`
from native builder jobs. `prepack` and `prepublishOnly` assert all four files, then compile
TypeScript without rebuilding a native. The ARM load job installs the same packed tarball
with no rebuild. The compile uses the `include/node` directory next to the running
Node binary, not a hardcoded `/usr/include/node`. Off Linux the compile script is a no-op, so
Windows `pnpm build` does not need headers or a C compiler. There is no `binding.gyp`, so
`pnpm install` does not infer `node-gyp rebuild`. Customer `npm i` does not compile it. A host
without a compiler installs the prebuilt natives; a missing native, an unsupported
`linux-<arch>`, or a load failure throws rather than compiling in place.

**Minimum glibc 2.34.** The natives are built on the plain `ubuntu-latest` and
`ubuntu-24.04-arm` runners, and `pty.node` binds `forkpty` at `GLIBC_2.34`; it also needs
`GLIBCXX_3.4.22` and `CXXABI_1.3.9`. `scripts/assert-native-ceiling.mjs` fails a native job
whose build needs anything newer. The child pidfd needs Linux 5.3; on an older kernel the
custodian refuses to launch rather than custody a child it cannot name.

The package.json has no `os` / `cpu` / libc fields. Manager depends on this package on every
platform: off Linux it still loads, and only `adopt` throws the named custody-transport error.
Gating install would skip the package on darwin and win32 and break that path. A musl or
non-Linux host that reaches `peerCredentials` throws; there is no compile fallback and no
silent degrade. First use of the helper is the right place for that refusal.

The launcher owns no PTY and exits after writing a permissioned per-seat record. Each custodian
owns exactly one pinned PTY child, its screen mirror, and exit observation; every signal it sends
goes through the child's pidfd, never a bare pid. A manager worker connects to that custodian over
a 0600 filesystem Unix socket authenticated by `SO_PEERCRED` uid match plus a per-seat capability
token. Path possession is not enough. Child exit is pushed to every authenticated controller socket.
After the child exits and the last authenticated client disconnects, the custodian closes the Unix
server, unlinks the socket, keeps the record, and exits. An active child, or a still-connected
observer of an exited child, keeps the process. A connected socket that never authenticated does
not: it owns no session, no output subscription and no wait, so a settle owes it nothing. A seat
whose child has already exited at listen stays up briefly so the launcher can adopt it.

A reap never signals a numeric pid or process group. It proves a seat gone only through its
contained cgroup. Without that proof it returns retained/unprovable, requesting a custodian stop
when it can read the record. A reaped seat's record stays until explicit release with
`removeSeatCustody`.

A custodian with no authenticated controller stops its child and exits after `UNATTENDED_MS`
(ten minutes, overridable at launch with `COTAL_SEAT_UNATTENDED_MS`). The window restarts at each
disconnect, so a manager that detaches and re-adopts keeps its seats; one that crashes, or a suite
that returns without reaping, no longer leaves a custodian holding memory for a controller that
will never come back. The bound is resolved by the launcher and carried in the launch payload,
because the custodian's own environment is scrubbed.

Every custodian carries `--cotal-run <marker>` on its argv and `COTAL_RUN` in its environment.
`COTAL_RUN` names the run when a caller sets one, otherwise the launching pid does.
`censusCustodians(run?)` reads that marker back out of `/proc/<pid>/cmdline`, which is
world-readable, so a reaper can find and attribute orphans without walking `/proc/*/cwd`.

`drainSeats(root, { drain })` lists the custody records under a root. A record that cannot be
read, or whose start and boot identity do not tie its pids to this boot, is reported as `refused`
and left on disk, with or without `drain`. On a host that publishes no boot identity, no record
can be tied to this boot, so every one is refused. A seat whose child still holds its recorded start
identity is reported as `live-child` and never signalled. With `drain`, every other seat goes
through `reapSeat`. One it cannot prove gone is reported as `refused` and left on disk.
`cotal seats [--drain]` is the operator command over it.

Generation CAS, the crash journal, N/N-1 protocol compatibility, and manager-worker activation
are later milestones. This package currently speaks a single implicit controller.
