# Pi managed-session provider retry control

A design record, not shipped behavior. Every current-behavior claim names the file and function it
was read from; everything else is proposed. Pi paths are `@earendil-works/pi-coding-agent` 0.79.10
`dist/`.

**Status:** draft. Implements RIG-4293 option 1 with the RIG-4543 boundaries and the RIG-4669 seat
root Matt approved, on Linux only (RIG-4707; see Resolved decisions). Managed Cotal Pi seats
disable Pi's automatic provider retry before the first provider turn. Operator sessions are
unchanged, and overflow compaction stays host-owned. PR #37 (RIG-4249) stays draft until this
control and the queued-inbound races are verified.

## Problem / Intent

`AgentSession._handlePostAgentRun` (`core/agent-session.js`) re-requests the provider after the turn
has ended: `if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) return true;`. Extensions
cannot see this. `willRetry` reaches only session listeners (`_handleAgentEvent`), and
`auto_retry_*` goes only through `_emit`. Cotal's `PiDriver.onAgentEnd` (`extensions/pi/src/driver.ts`)
holds an error-ended turn. `retryHeldErrorOnInbound` then starts one fresh turn on new automatic
inbound. So an inbound that lands during Pi's backoff can drive a second recovery path for the
same batch [INFERENCE from those functions, not reproduced]. Intent: in every runtime a managed seat
builds, effective `retry.enabled === false` before Pi's next provider request. If that cannot hold,
Pi makes no further provider request in that process, the seat says why, and it exits. Operator
settings files are never written.

## Approach

**No dedicated Pi control exists.**

- `cli/args.js` has no retry or settings flag.
- `MainOptions` (`main.d.ts`) is only `{ extensionFactories? }`.
- `ExtensionContext` (`core/extensions/types.d.ts`) exposes no settings manager.
- `AgentSession.setAutoRetryEnabled` → `SettingsManager.setRetryEnabled` writes
  `this.globalSettings.retry.enabled` and calls `save()`, the forbidden operator write. Its only
  external caller is RPC `set_auto_retry` (`modes/rpc/rpc-mode.js`).

**Carrier: a per-seat agent dir (decision 1).** It combines two documented Pi features:

- `getAgentDir` (`config.js`) honors `PI_CODING_AGENT_DIR`;
- `SettingsManager.getRetryEnabled` returns `this.settings.retry?.enabled ?? true`.

`_prepareRetry` and `_willRetryAfterAgentEnd` re-read `getRetrySettings()` on every attempt, so a
correct file at every read is enough. `piConnector.buildLaunch` converges a seat dir:

- `settings.json` = the operator's settings with `retry.enabled: false`;
- a **fixed allowlist** of symlinks back to the operator agent dir;
- `PI_CODING_AGENT_DIR` pointed at the seat dir.

The Cotal extension then verifies the result in every runtime.

**Why links, and why a fixed list.** Pi derives all of its state from the agent dir. Each name below
comes from a source read in this session:

- **Files:** `auth.json`, `models.json`, `trust.json`, `keybindings.json`, `SYSTEM.md`,
  `APPEND_SYSTEM.md`, and context files `AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD`.
- **Dirs:** `sessions`, `extensions`, `skills`, `prompts`, `themes`, `tools`, `bin`, `npm`, `git`, `tmp`.

Sources: `getAuthPath`/`getModelsPath`/`getToolsDir`/`getBinDir`/`getSessionsDir` (`config.js`),
`ProjectTrustStore` (`core/trust-manager.js`), `DefaultResourceLoader` user roots and `SYSTEM.md`
lookup (`core/resource-loader.js`), `DefaultPackageManager` `npm`/`git`/`tmp`
(`core/package-manager.js`), and keybindings (`core/keybindings.js`).

Copying only what exists at launch would make state seat-local and short-lived (F3):

- a `/login` writes a seat `auth.json` that the next launch loses;
- `ensureTool` re-downloads rg/fd into every seat dir;
- trust prompts repeat.

With a fixed list:

- **Files are linked even when missing.** Pi's first `writeFileSync` (e.g.
  `FileAuthStorageBackend.ensureFileExists`) then creates the operator file, which is what happens
  today.
- **Missing dirs are created in the operator dir**, as Pi would create them for an unmanaged run.
- Unlisted names (`pi-debug.log`, `*.lock`) stay seat-local.

**Converge, never delete (F2).** `buildLaunch` also runs on the resume preflight-only path
(`Manager`: `if (preflightOnly) return { ok: true, … }`, `implementations/manager/src/manager.ts`).
Recovery and resume reuse the same `lifecycleUid`. So the seat dir may belong to a live Pi.
`rm -rf` would leave a window where `settings.json` is missing (retry ON) and `sessions` is
missing (ENOENT). Instead:

- `settings.json` is written with `writeSecretFileAtomic` (`packages/core/src/secret-fs.ts`,
  temp plus `renameSync`), so it is never absent;
- each link is created if missing, or swapped through a temp link plus `renameSync` when
  `readlinkSync` differs;
- a re-run against a live seat is a no-op in effect.

**Project override (F1).** Pi builds one `SettingsManager` per runtime from the *session's* cwd:

- `createRuntime` in `main.js` is called with `cwd: sessionManager.getCwd()`;
- so are `AgentSessionRuntime`'s resume/fork paths (`core/agent-session-runtime.js`);
- no `process.chdir` exists in Pi.

`deepMergeSettings` (`core/settings-manager.js`) shallow-merges one level, and "for primitives and
arrays, override value wins". So a trusted project `.pi/settings.json` re-enables retry when it has
either:

- `retry.enabled` present and `!== false`;
- a `retry` that is not a plain object (`null`, `true`, `[]`).

Trust can change at reload (`DefaultResourceLoader` calls `settingsManager.setProjectTrusted`), so the
check ignores trust.

**Where the checks sit.** The check runs at every point where Pi can reach a provider, and every
failure closes the same one-way gate. Nothing throws. A factory throw fails closed only in the CLI:
the SDK loader records the error and drops the extension (`loadExtensionFactories`,
`core/resource-loader.js`), and only `main` (`main.js`) turns `getExtensions().errors` into exit 1.
A handler throw is caught by `ExtensionRunner.emit` (`core/extensions/runner.js`) and reported
through `emitError`, so it gates nothing.

- **At load.** The factory checks `process.cwd()`, because the load-time API has no cwd
  (`createExtensionAPI`, `core/extensions/loader.js`). On failure it registers only the barrier
  handlers below, starts no mesh runtime, and terminates. The extension stays loaded in every host.
- **In `session_start`.** It is emitted in `bindExtensions` before the initial prompt and on
  reload, new, resume and fork (`AgentSession.bindExtensions`, `AgentSession.reload`,
  `AgentSessionRuntime`). The check reads `ctx.cwd`, the session cwd that the runtime's
  `SettingsManager` was built from.
- **Before each request path.** `agent_start`, `session_before_compact` and `session_before_tree`
  re-run the check on `ctx.cwd` while the gate is open. This covers an SDK host that never calls
  `bindExtensions`; `createAgentSession` (`core/sdk.js`) does not call it.

An `input` handler cannot gate. `AgentSession.prompt` runs `_tryExecuteExtensionCommand` before
`emitInput`, and a command, a `withSession` continuation or any extension can call
`pi.sendMessage(…, { triggerTurn: true })`, which reaches the agent loop through
`sendCustomMessage` without `input`.

**Termination.** `closeRetryGate` sets the one-way gate before any fallible work. It then attempts
`driver.quit()`, persists session state `quit`, and writes a `pi connector:` reason to fd 2, each
in a separate guarded step. A failed step is recorded in the reason when stderr remains writable;
none can reopen the gate or skip termination. In a final guarded step it calls
`hooks.terminate(reason)` (default: own-process `SIGTERM`). Even if a test hook throws or returns,
`closeRetryGate` itself never throws and every provider-path handler parks or cancels based on the
already-closed gate. A host that prevents process termination must dispose the runtime; its
provider barrier remains closed until then.

Persisting `quit` lets `Manager.onAgentExit` retire a seat without `supervise`
(`freeSlot(a, true, "process-exit")`) instead of restarting it into the same failure (decision 2).
At load the id is `COTAL_PI_EXPECTED_SESSION`, and the manager readiness wait
(`awaitManagedSessionState`) reports a deliberate quit. A `--fork` launch has no expected id, so
nothing is written and the wait fails on the exited process. If persistence fails, the manager
must not infer a clean quit; this is a fail-loud lifecycle error, not permission for a provider
request.

At load, the CLI has no signal handler yet: `main` (`main.js`) builds the runtime, which loads
extensions, before `runPrintMode` or `InteractiveMode.init` registers one. The only `SIGTERM`
listener then is `signal-exit` 3.0.7, installed when Pi imports `proper-lockfile`; with no other
listener it unloads and re-raises the signal, so the process dies by `SIGTERM`.
Later, the CLI handlers run. Interactive `registerSignalHandlers` calls
`shutdown({ fromSignal: true })`, which awaits `runtimeHost.dispose()` and exits 0; print mode
(`print-mode.js`) disposes and exits 143. `AgentSessionRuntime.dispose` emits `session_shutdown`
and calls `AgentSession.dispose`, which aborts the agent without awaiting the turn. An SDK host
without its own handler dies the same way as at load.

`ctx.shutdown()` is not fail-closed. Print mode binds no `shutdownHandler`, so it is a no-op there.
Interactive mode's `shutdownHandler` (`InteractiveMode`) only sets `shutdownRequested` while
`session.isStreaming`, and a parked turn streams forever. `process.exit` is rejected: it skips
`session_shutdown` and terminal restore.

**Request barrier until exit.** A request can still start before the exit, for example from a
`withSession` continuation, which runs after `bindExtensions` (`finishSessionReplacement`). The
only `streamSimple`/`completeSimple` call sites in Pi's `dist/` give three request paths, and each
passes a Cotal handler first:

- **Turns.** The agent `streamFn` (`core/sdk.js`) runs only from `runLoop`, the only caller of
  `streamAssistantResponse` (pi-agent-core 0.79.10, `agent-loop.js`). `runAgentLoop` and
  `runAgentLoopContinue` first `await emit({ type: "agent_start" })`. `Agent.processEvents`,
  `AgentSession._handleAgentEvent` and `ExtensionRunner.emit` await each listener. Pi retry
  re-enters through `agent.continue()` (`_runAgentPrompt`), so it passes `agent_start` too.
- **Compaction.** `completeSimple` (`core/compaction/compaction.js`) runs only from `compact`,
  called by `AgentSession.compact` and `_runAutoCompaction`. Both emit `session_before_compact`
  first and stop on `cancel`: manual compaction throws `Compaction cancelled`, and auto compaction
  emits `compaction_end` with `aborted: true` and returns false. This covers the pre-prompt
  `_checkCompaction` in `AgentSession.prompt`, which runs before `agent_start`.
- **Branch summary.** `generateBranchSummary` (`core/compaction/branch-summarization.js`) runs only
  from `AgentSession.navigateTree`, after `session_before_tree`. `cancel` returns
  `{ cancelled: true }`.

With the gate closed, the `agent_start` handler awaits a promise that never settles, and both
`session_before_*` handlers return `{ cancel: true }`. The promise must never resolve or reject:
`streamAssistantResponse` has no aborted-signal precheck, and `emit` swallows a throw, so either
would let the request go out. A cancel wins over any other extension's result, because
`ExtensionRunner.emit` returns on the first `cancel`. Requests that an operator extension makes
from its own code are outside this record; they carry no Pi retry.

**No reopen (PR #45 R2).** The gate is one-way. The earlier draft held the driver and reopened on a
later passing `session_start`, but `PiDriver.onSessionStart` never clears `held`, so the hold
outlived the gate. The gate now never calls `PiDriver.hold`, and a seat whose checks pass
dispatches exactly as today.

**Nothing else turns retry on.** `SettingsManager` re-reads its files only in `reload()`, called
from `AgentSession.reload` and `DefaultResourceLoader.reload`; each is followed by a
`session_start`. The only in-memory switch, `setAutoRetryEnabled`, is reached only from RPC
`set_auto_retry`, and `buildLaunch` never selects rpc mode.

**Runtime pin (F4).** The binary is the operator's `pi` (`buildLaunch` returns
`opts.resolvedBinaries?.pi ?? "pi"`), not the devDependency. So managed mode imports `VERSION` from
the host package and refuses anything but `0.79.10`. The standalone bundle externalizes the package,
and the loader aliases it to the host copy.

**What stays the same.**

- **Overflow.** `_isRetryableError` excludes context overflow, and its compaction path reads only
  compaction settings.
- **No Pi re-request, but a post-run step remains (F9).** An error `agent_end` no longer leads to a
  Pi-initiated re-request. However, `_handlePostAgentRun` still runs `_checkCompaction`, which can
  run `_runAutoCompaction("threshold", false)` after an error turn. Task 3 tests inbound arriving
  during that window.

**Rejected alternatives.**

- **Patching `SettingsManager.prototype` from the extension.** It reaches the host class through
  the loader alias but is not a supported API.
- **Blanking `errorMessage` at `message_end`.** It relies on an undocumented short-circuit in
  `_isRetryableError`, drops the error text that AG-UI `runError` uses, and blinds
  `isContextOverflow`.
- **`setRetryEnabled`.** It is an operator write.
- **A factory throw at load.** It fails closed only in the CLI. An SDK host drops the extension and
  runs without any gate.

## Global Constraints

- **Pi is exactly 0.79.10**, enforced at runtime (F4) and in `pi-sdk.smoke.ts`. A Pi bump re-verifies
  every Pi fact above.
- **Never write the operator's `settings.json`.** Operator-dir writes are limited to:
  - creating missing allowlisted dirs;
  - Pi's own writes through the links, as today.
- **Operator sessions are unchanged.** Every new check keys on `COTAL_PI_AGENT_DIR`, which only
  `buildLaunch` sets.
- **Fail loudly.** Every error starts with the `pi connector:` prefix and names the path. There is no
  fallback that keeps retry on.
- **Fail closed, one way.** A failed check, at load or in any runtime, ends the process
  (`closeRetryGate`). Nothing reopens the gate.
- **Host contract.** Supported hosts are the Pi CLI as `buildLaunch` starts it (interactive or
  print mode) and SDK hosts that load the extension through Pi's loader. A host must let
  `hooks.terminate` end the process, or dispose the runtime itself; until then the barrier holds.
  Only `COTAL_PI_AGENT_DIR`, which `buildLaunch` sets, turns any of this on (decision 7).
- **Only `retry.enabled` is forced.** Compaction and `retry.provider.*` are copied unchanged
  (decision 6).
- **Seat dir:** `<seat root>/<name>-<lifecycleUid>`, private user state outside the shared
  workspace and outside `COTAL_HOME` (decisions 3 and 5). `seatAgentRoot` reads only the launch
  env, first match wins:
  1. `XDG_STATE_HOME`: `<XDG_STATE_HOME>/cotal/pi-agent`;
  2. `HOME`: `<HOME>/.local/state/cotal/pi-agent`.

  The order follows `globalConfigDir` (`packages/core/src/connector-config.ts`), which returns
  `join(xdg, "cotal")` for a set `XDG_CONFIG_HOME` and else `join(homedir(), ".config", "cotal")`.
  The step 2 default is the XDG Base Directory one ("a default equal to `$HOME`/.local/state
  should be used"). `launchEnv` forwards both variables (`OS_ENV_ALLOW`,
  `extensions/connector-core/src/launch.ts`). Rules:
  - a value that is empty after `trim()` counts as unset, as in `globalConfigDir` and the XDG spec;
  - a relative value throws, naming its variable; it is never resolved against the cwd. The XDG
    spec calls a relative path invalid and says to ignore it. Ignoring it would move every seat
    dir to the next step without a word, so this refuses instead (Fail loudly);
  - with `XDG_STATE_HOME` unset, a missing `HOME` throws. There is no `os.homedir()` fallback,
    which falls back to a passwd lookup;
  - `COTAL_HOME` and `XDG_CONFIG_HOME` are never read. `cotal service install` points both into
    `serviceStateDir` (`<unit dir>/cotal-service/<spaceKey>/`), and `uninstall` runs
    `rmSync(serviceStateDir(dir, fields.mesh), { recursive: true, force: true })`
    (`implementations/cli/src/commands/service.ts`). A root under either would lose retained seat
    dirs.

  The root and the seat dir are created with `mkSecretDir` (`packages/core/src/secret-fs.ts`):
  `mkdirSync(…, { recursive: true, mode: 0o700 })`, then `hardenPrivate`, which chmods it to 0o700.
  - `buildLaunch` validates both parts of `<name>-<lifecycleUid>` before any path is joined from
    them. `assertValidName` (`packages/core/src/resolve.ts`) refuses `/` and `\` in the name.
    `assertLifecycleToken` (`packages/core/src/subjects.ts`, `/^[a-z0-9]{26,32}$/`) checks the
    uid. So the leaf is one path segment, and the seat dir and the session-state file stay
    contained in their roots. The name stays raw (decision 8).
  - The uid is minted once per lifecycle (`mintLifecycleUid`) and reused by recovery and resume.
    So the dir is unique across workspaces, and `--session-id` recovery reopens the same session
    path string.
  - Fork `parentSession` headers record seat paths (`SessionManager.forkFrom`), because Pi uses
    `resolvePath`, not `realpath` (F6). Retention (decision 5) keeps those paths resolvable.
- **Operator agent dir:** the launch env's `PI_CODING_AGENT_DIR` if the operator forwarded it via
  `envAllow` (`launchEnv`), else `join(HOME, ".pi", "agent")`, with `~` expanded against `HOME`.
  `HOME` is what `os.homedir()` reads first on Linux (Node `os` docs), and Pi's `getAgentDir`
  (`config.js`) calls `homedir()`. A missing or relative `HOME` throws, with no `os.homedir()`
  fallback.
- **Linux only (RIG-4707).** Links are symlinks, and a link that cannot be made fails loudly. No
  task adds a win32 or macOS branch, path, link type or test cell (decision 8).
- **One PR, no inert flag.**

## Plan

### Task 1: converge the seat dir in `buildLaunch`

New file `extensions/pi/src/retry-control.ts`:

```ts
export const COTAL_PI_AGENT_DIR = "COTAL_PI_AGENT_DIR";
export const PI_VERSION = "0.79.10";
export function operatorAgentDir(env: Readonly<Record<string, string | undefined>>): string;
/** `<root>/pi-agent` for managed Pi seats, from the launch env only (Global Constraints, Seat
 *  dir). Pure: creates nothing. Throws "pi connector: …" naming the variable on a missing or
 *  relative value. */
export function seatAgentRoot(env: Readonly<Record<string, string | undefined>>): string;
/** Idempotent and safe against a live seat. Throws "pi connector: …". Never deletes. */
export function convergeSeatAgentDir(seatDir: string, operatorDir: string): void;
```

`convergeSeatAgentDir`:

1. **Refuse unsafe seat paths.** `lstat` the seat root (`dirname(seatDir)`) and `seatDir`. If
   either is a symlink, throw. Then `mkSecretDir` both.
2. **Read and validate operator settings.** Read `<operatorDir>/settings.json`, or use `{}` if it is
   absent. Throw on:
   - JSON that does not parse;
   - a value that is not a plain object;
   - legacy credentials: an `apiKeys` key, or `<operatorDir>/oauth.json` existing.
     `migrateAuthToAuthJson` (`migrations.js`) would otherwise copy them into each seat dir. The
     message is `run pi once to migrate them into auth.json`.
3. **Check path entries (F5).** This covers string entries, and object sources, of `packages`,
   `extensions`, `skills`, `prompts` and `themes`.
   - Strip one leading `!`/`+`/`-` marker.
   - Skip non-local sources (the `isLocalPath` prefixes in `utils/paths.js`), `~` paths and
     absolute paths.
   - For each remaining relative entry, compute `r = relative(operatorDir, resolve(operatorDir, e))`.
     Throw if `r` starts with `..` or is absolute, which is the `contained` test in
     `implementations/cli/src/commands/backup.ts`.
   - Throw if the entry's first segment has glob metacharacters. Otherwise add that segment to the
     link set.
   - Throw if `sessionDir` is relative.
4. **Write the seat settings.** `writeSecretFileAtomic(<seatDir>/settings.json, …)` with
   `{ ...op, retry: { ...(plain(op.retry) ? op.retry : {}), enabled: false } }`.
5. **Converge the links.** For each name in the allowlist plus the link set:
   - a missing operator dir is created first with `mkdirSync(…, { recursive: true })`;
   - a seat entry that exists but is not a link throws;
   - a link with the wrong target is swapped atomically.

In `piConnector.buildLaunch` (`extensions/pi/src/connector.ts`):

- **Validate the leaf first.** After the existing argument refusals and before `stateRoot`:
  - throw `pi connector: a managed Pi seat requires lifecycleUid for its private Pi agent
    directory` when `lifecycleUid` is missing;
  - call `assertLifecycleToken(opts.lifecycleUid, "pi connector: lifecycleUid")`;
  - call `assertValidName(opts.name)`. `CotalEndpoint` (`packages/core/src/endpoint.ts`) already
    runs `assertValidName(opts.card.name)` on every join, so a name with `/` or `\` cannot reach a
    live seat today.

  `cotal spawn` can take the uid from a remote provisioning response, and
  `checkRemoteAgentMaterial` (`implementations/cli/src/commands/spawn.ts`) checks it only as a
  non-empty string. Today that value reaches
  ``join(stateRoot, `${opts.name}-${opts.lifecycleUid ?? "unmanaged"}.json`)`` and then
  `rmSync(sessionStatePath, { force: true })`, so an unchecked uid such as `x/../../victim` deletes
  `<workspaceRoot>/.cotal/victim.json`. A `relative`/`startsWith` check on the joined path would
  not be enough here: `join` normalizes the `..` away first, and the session-state `rmSync` runs
  before the seat root is known.
- **Drop the dead fallback.** That join uses the validated uid, and `?? "unmanaged"` is removed.
  The spelling `<name>-<lifecycleUid>.json` does not change, so the two readers that derive it,
  instead of reading a carried path, keep finding what new launches write:
  `Manager.retainedSessionId` (`implementations/manager/src/manager.ts`), for an inventory entry
  with no `sessionId`, and `sessionStatePath` in `extensions/pi/src/extension.ts`, for a seat
  launched before `COTAL_PI_SESSION_STATE` existed. An entry has no `sessionId` when the seat's
  readiness was uncertain, because `resumeEntry` reads one only once recovery is armed
  (`a.restart?.armed ? this.readManagedSession(a) : a.launch.sessionId`). Neither reader changes.
- **Converge the seat dir** after `env` is built and before the persona temp dir:
  - `root = seatAgentRoot(env)`, ``leaf = `${opts.name}-${opts.lifecycleUid}` ``,
    `seatDir = join(root, leaf)`;
  - throw `pi connector: seat dir ${seatDir} escapes ${root}` unless
    `dirname(seatDir) === resolve(root) && basename(seatDir) === leaf`. The leaf checks above make
    this hold by construction; the assert keeps it holding if the leaf format changes. Unlike a
    `relative(root, seatDir) === leaf` test, it fails for `../x-<uid>`, because `join` has already
    normalized the `..`;
  - `convergeSeatAgentDir(seatDir, operatorAgentDir(env))`;
  - set `env.PI_CODING_AGENT_DIR` and `env.COTAL_PI_AGENT_DIR` to `seatDir`.

`LaunchOpts.lifecycleUid` stays optional in `packages/core/src/connector.ts`: requiring it changes
the public type for every connector. Pi refuses at runtime instead. That is a behavior change for
SDK callers of `piConnector.buildLaunch` (exported from `@cotal-ai/pi`) that omit the uid. Every
production launcher passes one: `Manager` spawn and resume, the `Manager` restart path (it reuses
the spawn opts) and `cotal spawn`. The seat dir does not depend on `workspaceRoot`.

**Tests** (`pi.smoke.ts`). The cells are Linux-only (RIG-4707). `pnpm test` reaches `pi.smoke.ts`
through the `extensions/pi` `test` script, and the Windows required lane
(`.github/workflows/windows.yml`, "Unit tests") still runs `pnpm test`. No cell adds a win32
skip, so Task 1 cannot land while that lane is required. Retiring the lane is not part of this
record.

Resolver cells call `seatAgentRoot(env)` with literal paths and create nothing:

- `{ XDG_STATE_HOME: "/s", HOME: "/h" }` gives `/s/cotal/pi-agent`;
- `{ HOME: "/h" }` gives `/h/.local/state/cotal/pi-agent`;
- `{ XDG_STATE_HOME: "  ", HOME: "/h" }` gives the `HOME` default;
- adding `COTAL_HOME` and `XDG_CONFIG_HOME` to any cell above leaves its result unchanged;
- each refusal names its variable: `XDG_STATE_HOME: "state"`, no `HOME`, and `HOME: "h"`.

Launch cells run `buildLaunch` with a temp `HOME`, a temp `XDG_STATE_HOME`, temp `COTAL_HOME` and
`XDG_CONFIG_HOME`, and a fake operator dir. Assert:

- the env vars are set, and the seat dir is
  `<XDG_STATE_HOME>/cotal/pi-agent/<name>-<lifecycleUid>`, with mode 0700;
- nothing is created under `COTAL_HOME`, `XDG_CONFIG_HOME` or `<workspaceRoot>/.cotal/pi-agent`;
- the seat settings are `{ enabled: false, maxRetries: 7 }` and other keys are kept;
- every allowlisted link exists, including a dangling `auth.json`;
- missing dirs were created in the operator dir;
- the operator `settings.json` bytes are unchanged;
- a second call with the same uid leaves link inodes and a planted `pi-debug.log` intact;
- a call with a second uid leaves the first seat dir and its `settings.json` bytes in place;
- with `XDG_STATE_HOME` unset and `COTAL_HOME=<svc>`, `XDG_CONFIG_HOME=<svc>/config` as a service
  unit sets them, `rmSync(<svc>, { recursive: true, force: true })` (what `uninstall` does to
  `serviceStateDir`) leaves the seat dir under `<HOME>/.local/state/cotal/pi-agent`, with its
  `settings.json`;
- `rmSync(seatDir, { recursive: true })` leaves operator files in place;
- the `envAllow` forwarded dir is honored;
- `launch.sessionStatePath` and `env.COTAL_PI_SESSION_STATE` both equal
  ``join(workspaceRoot, ".cotal", "pi-sessions", `${name}-${lifecycleUid}.json`)``, the path
  `Manager.retainedSessionId` derives. The absent-`sessionId` resume cells in
  `implementations/manager/smoke/pi-session-recovery.smoke.ts` ("an older inventory recovers the
  exact session from lifecycle-keyed upgrade state" and its fail-loud twin) already cover that
  reader, so they do not change.

Each refusal case throws its message:

- `apiKeys`, or `oauth.json` present;
- `extensions: ["x/../../e.ts"]`;
- a relative `sessionDir`;
- a relative `XDG_STATE_HOME`, and nothing is created under the cwd;
- no `HOME` and no forwarded `PI_CODING_AGENT_DIR`;
- a symlinked seat root;
- a real dir at an allowlisted name;
- no `lifecycleUid`;
- `lifecycleUid: "x/../../victim"` throws `not a valid lifecycle token`. A planted
  `<workspaceRoot>/.cotal/victim.json` survives, and nothing is created under the seat root;
- `name: "../x"` with a valid uid throws `invalid name`. A planted
  `<workspaceRoot>/.cotal/x-<uid>.json` survives, and `<dirname(root)>/x-<uid>` does not exist.

Existing smokes change with the new refusal:

- **`pi.smoke.ts`.** Every call that should build, or reach a refusal after the uid check, passes a
  valid `lifecycleUid`. That covers events without `workspaceRoot`, `creds` with `userAuth`, and the
  prompt refusals. The `/workspaceRoot/` cell becomes
  `buildLaunch({ space: "test", name: "pi", lifecycleUid })`, so it still proves the events
  refusal, not the uid one. The `resume`+`continueSession`, `variant`, MCP and launch-options
  refusals run before the uid check and stay as they are.
- **`pi-sdk.smoke.ts`.** The `pi-events-sdk` launch passes a `lifecycleUid`.
- **`bin/smoke/seat-env-scope.smoke.ts`.** It already passes `mintLifecycleUid()`.

All three set a temp `HOME` and a temp `XDG_STATE_HOME` before the first `buildLaunch`, so no smoke
converges a seat or creates operator dirs in the real user home.

### Task 2: verify in the extension

```ts
export type RetryCheck = { ok: true } | { ok: false; reason: string };
/** { ok: true } unless env[COTAL_PI_AGENT_DIR] is set. */
export function checkManagedRetryOff(env: Readonly<Record<string, string | undefined>>, cwd: string, hostVersion: string): RetryCheck;
```

The check fails when any of these holds:

- `hostVersion !== PI_VERSION`;
- `PI_CODING_AGENT_DIR !== COTAL_PI_AGENT_DIR`;
- the seat `settings.json` is missing, does not parse, or has `retry.enabled !== false`;
- `<cwd>/.pi/settings.json` parses and its `retry` is either not a plain object or has `enabled`
  present and `!== false`.

An unparseable project file passes, because `tryLoadFromStorage` then yields `{}`.

Wiring in `extensions/pi/src/extension.ts`. The default `cotalMesh(pi)` becomes a call to a new
export, passing `terminate: () => process.kill(process.pid, "SIGTERM")`:

```ts
export type CotalMeshHooks = { terminate(reason: string): void };
export function installCotalMesh(pi: ExtensionAPI, hooks: CotalMeshHooks): Promise<void>;
```

Gates live in a `globalThis` map, `Symbol.for("cotal.pi.retryGates")`, keyed by `runtimeKey`. The
map is global, like `RUNTIMES`, because the loader builds jiti with `moduleCache: false`
(`core/extensions/loader.js`), so module state does not survive a reload. `PiRuntime` keeps the
hooks of its first load. Module-private helpers:

```ts
type GateScope = { key: string; hooks: CotalMeshHooks; runtime?: PiRuntime; sessionId?: string };
/** Sets the gate first; catches every side-effect failure and always attempts termination. */
function closeRetryGate(scope: GateScope, reason: string): void;
/** Returns true when closed or when a failed check closes it; never throws. */
function gateClosed(scope: GateScope, cwd: string): boolean;
```

`gateClosed` maps any exception from the check to a failure, because a throw inside
`session_before_compact` would be swallowed and compaction would run.

- **At load.** After `runtimeKey(config)` and before the `RUNTIMES` lookup, call `gateClosed` with
  `process.cwd()` and the captured `expectedSessionId`. If it is closed, register only the three
  barrier handlers and return without creating a runtime. Never throw.
- **In `session_start`.** If the gate is set, return first, so a closed seat never writes
  `running` again. Otherwise run `gateClosed` on `ctx.cwd` right after `runtime.sessionId` is set
  and before `persistSessionId(runtime.sessionId)`, and return if it is closed.
- **Barrier handlers.** Each starts with the gate test, before any existing work:
  - `agent_start`: `if (gateClosed(scope, ctx.cwd)) await PARKED;`, with the module-level
    `const PARKED: Promise<never> = new Promise(() => {})`;
  - `session_before_compact`: `if (gateClosed(scope, ctx.cwd)) return { cancel: true };`, before
    `driver.onBeforeCompact`;
  - `session_before_tree`: the same, as a new handler.

**Tests:**

- **Unit cases.** Project `retry` values `{enabled:true}`, `null`, `true` and `[]` fail.
  `{maxRetries:5}`, `{enabled:false}` and an unparseable file pass. A seat file with
  `enabled:true`, a mismatched dir and `hostVersion "0.80.0"` fail. With no `COTAL_PI_AGENT_DIR`,
  the check passes, which proves operator sessions are unchanged.

The runtime tests go in the broker-backed block of `pi-sdk.smoke.ts` (`nats-server`), where
`cotalMesh` already runs. `COTAL_PI_AGENT_DIR` and `PI_CODING_AGENT_DIR` point at a converged seat
dir, and `COTAL_PI_SESSION_STATE` at a temp file. Each runtime uses a distinct `COTAL_ID`, because
gates and `runtimeMap` are keyed by identity. A parked turn never settles, so no closed-gate test
awaits it. "No request" means the faux provider's `state.callCount` did not move within 300 ms.

- **Closed gate, every trigger (PR #45 R1).** Use the existing
  `createAgentSessionRuntime(createRuntime, …)` pattern with two factories:
  `(pi) => installCotalMesh(pi, { terminate: record })`, and one that registers `/kick`, whose
  handler calls `pi.sendMessage({ customType: "kick", content: "kick", display: true },
  { triggerTurn: true })`. Close the gate by switching to a session whose cwd has
  `.pi/settings.json` `{ "retry": { "enabled": true } }`. Fire one trigger per fresh runtime,
  without awaiting it:
  - `prompt("/kick")` after the switch;
  - `prompt("typed")` after the switch;
  - the switch's own `withSession`, calling `ctx.sendMessage(…, { triggerTurn: true })`.

  Assert no request, that `record` ran once with a reason naming the project file, and that the
  session-state file reads `quit`.
- **Positive control.** The same `/kick` in a runtime on a passing cwd makes exactly one provider
  call, and `record` never runs.
- **Valid switch, automatic inbound (PR #45 R2).** Start an `installCotalMesh` runtime, switch to a
  second session on a passing cwd, then send one DM from the observer `CotalEndpoint` with
  `unicast`, which `agent.dm` uses. Assert exactly one more provider call, one `cotal-inbox`
  `message_start` carrying that id, and that `record` never ran.
- **First runtime fails at load (rereview 1).** `process.chdir` into the failing project, then
  build the first runtime. Assert that `getExtensions().errors` is empty, that `record` ran once,
  and no request after an unawaited `prompt("typed")`.
- **Host that never binds (rereview 1).** Load from a passing `process.cwd()` with a failing
  session cwd, and never call `bindExtensions`. Assert no request after an unawaited
  `prompt("typed")`, and that `record` ran once.
- **Compaction and branch summary while closed (rereview 2).** Register the faux model with
  `contextWindow: 1000`, and set `compaction` to `{ reserveTokens: 200, keepRecentTokens: 1 }` so
  `prepareCompaction` has messages to summarize. Seed a session on the failing cwd with two
  user/assistant exchanges, the last assistant reporting `usage.totalTokens: 900`, and switch to
  it. Assert:
  - no request after an unawaited `prompt("typed")`, which runs the pre-prompt `_checkCompaction`;
  - `compact()` rejects with `Compaction cancelled`;
  - `navigateTree(<the first user entry>, { summarize: true })` resolves `{ cancelled: true }`.
- **Failure injection.** Make state persistence throw and make `hooks.terminate` throw in separate
  runtimes. In the first, a recording termination hook is called exactly once despite the write
  failure, and the write error does not escape the Pi handler. In the second, a throwing hook is
  called exactly once and its error also does not escape. In both, the gate stays closed: an
  unawaited turn makes zero provider requests, `compact()` rejects as canceled, and
  `navigateTree` returns canceled. A healthy-path control must make a request, so a broken faux
  provider cannot make both cases vacuously pass.
- **Compaction control.** The same seeded session on a passing cwd: `compact()` moves
  `state.callCount`. Without it, the closed case could pass on a session too small to compact.
- **Pi CLI process runs (rereview 3).** Spawn `node <pi dist/cli.js> --extension
  <dist/standalone.js> --approve --provider cotal-test --model m`. The operator `models.json`,
  reached through the seat link, defines `cotal-test` with `api: "openai-completions"` and a
  `baseUrl` on a local HTTP server that counts requests and answers 400. Cases:
  - **load, print:** cwd is the failing project, with `--session-id <uuid> -p hi` and
    `COTAL_PI_EXPECTED_SESSION` set to that id. The child ends by signal `SIGTERM`, because no Pi
    handler exists yet;
  - **`session_start`, print:** cwd passes, with `--session <seeded file on the failing project>
    -p hi`. Exit code 143 from the `runPrintMode` handler;
  - **`session_start`, interactive:** the same without `-p`, under `ptySpawn`
    (`implementations/cli/smoke/_console-pty.ts`). Exit code 0 from
    `shutdown({ fromSignal: true })`;
  - **control:** the print case with a passing session cwd makes exactly one request and prints no
    `pi connector:` line.

  Every failing case asserts zero requests, stderr naming the project file, and state `quit`.

### Task 3: prove Pi honors the generated file

In `pi-sdk.smoke.ts` (existing smokes use `SettingsManager.inMemory`):

1. **Merge pins.** Build the seat dir with `convergeSeatAgentDir`, then run
   `SettingsManager.create(project, seatDir, { projectTrusted: true })`:
   - project `{retry:{maxRetries:5}}` gives `enabled === false`;
   - project `{retry:null}` gives `enabled === true`, pinning the hazard Task 2 gates.
2. **Runtime.** File-backed settings, the faux provider, and `cotalMesh`. The first response is
   `fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" })`. Wait
   2500 ms, longer than the 2000 ms first backoff. Assert:
   - no `auto_retry_start`;
   - `agent_end.willRetry === false`;
   - one provider call;
   - the driver is `held`.

   Then one automatic inbound must produce exactly one more call and a clean boundary.
3. **Control.** With `{retry:{enabled:true, baseDelayMs:1}}`, assert `auto_retry_start` and two calls.
4. **Post-run compaction (F9).** Same as step 2, with context above the compaction threshold, and an
   inbound delivered while threshold compaction runs. Assert:
   - no concurrent turns;
   - exactly one provider call after compaction;
   - the inbox is acknowledged once.

   A red result here blocks PR #37 promotion, per RIG-4293's queued-inbound-race gate, and is fixed
   in `PiDriver.retryHeldErrorOnInbound` on the RIG-4249 line.

### Task 4: docs and rollout

- **`docs/connect-pi.md`.** In the paragraph "Pi emits `agent_end` to extensions without exposing
  whether it will retry", add that a managed seat runs with Pi retry off through a per-seat agent
  dir, and that operator sessions keep the existing ambiguity.
- **`extensions/pi/README.md`.** Near "Pi exposes no retry-finality event", add:
  - the seat dir location, and that Cotal keeps one per lifecycle (decision 5);
  - the refused project `retry` values, and that a failed check ends the seat, including after a
    mid-session edit (decision 7);
  - that seat-pane settings changes persist only to the seat copy;
  - the runtime pin.
- **`docs/design/session-recovery.md` § 4.2.** Amend the adopted recovery-rule paragraph to match.
- **`docs/config.md`.** Add a § State files after § Configuration files: `pi-agent/` under the
  seat root, its precedence, that `COTAL_HOME` does not move it and `service uninstall` does not
  remove it, and that Cotal keeps one seat dir per lifecycle.
- **Changeset.** Add `.changeset/pi-managed-retry-off.md` (`"@cotal-ai/pi": patch`).
- **Rollout.** A seat gets the control at its next launch or supervised restart. Seats that are
  already running keep retry until then.

## Tasks

- [ ] Task 1: `operatorAgentDir`, `seatAgentRoot`, `convergeSeatAgentDir` and the `buildLaunch`
  wiring (uid validation, seat dir containment, no `unmanaged` fallback), with the Linux-only
  resolver, location, retention, session-state path, refusal and convergence tests and the smoke
  updates. It cannot land while the Windows required lane runs `pnpm test`.
- [ ] Task 2: `checkManagedRetryOff`, the gate map, `closeRetryGate`, `gateClosed`, the load,
  `session_start` and barrier handlers, and the `installCotalMesh` seam, with the unit,
  every-trigger, positive-control, valid-switch, load, unbound-host, compaction and Pi CLI tests.
- [ ] Task 3: merge pins, the retry-off proof, the retry-on control and the post-run compaction
  race.
- [ ] Task 4: `connect-pi.md`, `README.md`, `config.md`, `session-recovery.md` § 4.2 and the
  changeset.

## Resolved decisions

Matt approved the RIG-4543 recommendation on 2026-10-06 ("Recommendation lgtm") and RIG-4669
option 1, the HOME/XDG state root ("Opt 1"). He ruled in RIG-4707 that Cotal is Linux-only and
drops all Windows support. Each entry gives the choice, the reason, and what lost.

1. **Carrier: per-seat Pi agent dir.** It uses only documented Pi inputs (`PI_CODING_AGENT_DIR`,
   `retry.enabled`). Rejected:
   - a Cotal launcher on the Pi SDK. `MainOptions` takes only factories, so `main.js` startup,
     trust and TUI wiring would be re-implemented against 0.79.10 internals;
   - waiting for an upstream control (a flag, an env var, or `willRetry` on the extension
     `agent_end`). None exists in 0.79.10 or the 1.0.2 changelog, and #37 would stay blocked.
2. **Project override: per-runtime check with termination.** The load check and the `ctx.cwd`
   check in every runtime close the gap and keep project resources. A failure ends the process
   instead of holding the seat, as the PR #45 review asked. Rejected: `--no-approve`, which drops
   project extensions/skills/prompts and does not reach an SDK host; a load-only check, which
   misses resume or fork into another project.
   - **The terminated seat retires.** The persisted `quit` makes `Manager.onAgentExit` free a
     seat without `supervise`. A restart would reopen the same session and fail again.
   - **A `supervise` seat still restarts** on any exit (`restart.policy`), fails the same check,
     and retires as `supervise-crash-loop` at its policy limit. Exempting it needs a manager
     change, which this record does not make.
3. **Seat dir: private user state outside the shared workspace and `COTAL_HOME`.** A shared
   workspace is reachable by everything else that uses it: other users, project tooling, agents
   confined to it. Seat-local files (`pi-debug.log`, `*.lock`) also stay out of project trees. The
   root is the user state root in Global Constraints (RIG-4669 option 1). It survives
   `cotal service uninstall`, and `COTAL_HOME` keeps the registry-only meaning `docs/config.md`
   gives it. Pi seats still run unconfined as the launching user (no sandbox in
   `extensions/pi/src`), so a same-user process can edit a seat dir. The symlink refusals, the
   containment check and the per-runtime check stay for that reason. Rejected:
   - `<workspaceRoot>/.cotal/pi-agent`, which is shared-workspace exposure;
   - `<COTAL_HOME>/pi-agent`. `uninstall` deletes a service's `COTAL_HOME`, dangling retained fork
     paths, and the root would widen `COTAL_HOME` past the registry.
4. **Credentials: linked.** `auth.json` and `trust.json` link to the operator files. The operator
   dir stays the one credential owner, and OAuth refresh tokens never fork. Accepted risk: OAuth
   refresh (`withLockAsync` → `lockfile.lock`) locks the canonical file, because `realpath`
   defaults to true in proper-lockfile 4.1.2. Sync `withLock` and the trust lock pass
   `realpath: false`, so they lock beside the seat link, and a seat's sync write does not exclude
   the operator's. Rejected: a copy at launch (a second secret copy per seat, and refresh tokens
   drift) and provider env keys only (breaks OAuth subscriptions).
5. **Retention: one seat dir per lifecycle, never deleted by Cotal.** No safe cleanup contract
   exists. Deletion can race a live seat (F2). It needs a `LaunchSpec` cleanup field, a public API
   change in `packages/core/src/connector.ts`. It also dangles fork `parentSession` paths recorded
   through the seat dir (F6). A seat dir holds only `settings.json`, links and seat-local files.
   Retention holds because no Cotal command deletes the seat root. `service uninstall` removes only
   `serviceStateDir`, and `removeLocalState` (`implementations/cli/src/commands/clean.ts`) deletes
   "the stopped mesh's local state" by "paths relative to the root".
6. **Provider-internal retry: the operator's `retry.provider.*` is kept.** It runs inside one
   `streamSimple` call. The agent `streamFn` (`core/sdk.js`) passes
   `providerRetrySettings.maxRetries`, and the pi-ai 0.79.10 providers that read it default it to
   0 (`maxRetries: options?.maxRetries ?? 0`). Pi turn retry stays off either way. Forcing 0 would
   change opted-in operator behavior.
7. **Host scope: re-check before every request path, with a stated host boundary.** The check runs
   at load, in `session_start`, and in `agent_start`, `session_before_compact` and
   `session_before_tree`. So any host that loads the extension fails closed, including one that
   never binds. Global Constraints names the supported hosts and their termination duty. A project
   file edited mid-session ends the seat before Pi reloads it, a false positive in the safe
   direction. Rejected: a check at load and `session_start` only, because an SDK host that never
   calls `bindExtensions` gets no session-cwd check; a CLI-only contract with a load-time throw,
   because an SDK host given a managed env fails open.
8. **Platform: Linux only (RIG-4707), with the raw seat leaf.** No task carries a win32 or macOS
   path, link type, env lookup or test cell. The leaf stays `<name>-<lifecycleUid>`. On Linux,
   `assertValidName` and `assertLifecycleToken` already make it one path segment, the
   containment assert still guards the join, and a NUL byte or an over-long name fails loudly in
   Node (`ERR_INVALID_ARG_VALUE`, `ENAMETOOLONG`, measured with `writeFileSync`) instead of
   resolving elsewhere. The raw spelling also keeps `Manager.retainedSessionId` and the
   extension's `sessionStatePath` fallback on the path new launches write. Rejected: the hex leaf
   and case-insensitive env lookup from the #45 review. Their reasons were Windows file-name
   rules, case-insensitive file systems and Windows env casing, and the hex leaf needed a manager
   reader change.
