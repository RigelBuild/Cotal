# Pi managed-session provider retry control

A design record, not shipped behavior. Every current-behavior claim names the file and function it
was read from; everything else is proposed. Pi paths are `@earendil-works/pi-coding-agent` 0.79.10
`dist/`.

**Status:** draft. Implements RIG-4293 option 1. Managed Cotal Pi seats disable Pi's automatic provider
retry before the first provider turn. Operator sessions are unchanged, and overflow compaction stays
host-owned. PR #37 (RIG-4249) stays draft until this control and the queued-inbound races are
verified.

## Problem / Intent

`AgentSession._handlePostAgentRun` (`core/agent-session.js`) re-requests the provider after the turn
has ended: `if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) return true;`. Extensions
cannot see this. `willRetry` reaches only session listeners (`_handleAgentEvent`), and
`auto_retry_*` goes only through `_emit`. Cotal's `PiDriver.onAgentEnd` (`extensions/pi/src/driver.ts`)
holds an error-ended turn. `retryHeldErrorOnInbound` then starts one fresh turn on new automatic
inbound. So an inbound that lands during Pi's backoff can drive a second recovery path for the
same batch [INFERENCE from those functions, not reproduced]. Intent: in every runtime a managed seat
builds, effective `retry.enabled === false` before its next provider request. If that cannot hold, the
seat runs no turn and says why. Operator settings files are never written.

## Approach

**No dedicated Pi control exists.**

- `cli/args.js` has no retry or settings flag.
- `MainOptions` (`main.d.ts`) is only `{ extensionFactories? }`.
- `ExtensionContext` (`core/extensions/types.d.ts`) exposes no settings manager.
- `AgentSession.setAutoRetryEnabled` → `SettingsManager.setRetryEnabled` writes
  `this.globalSettings.retry.enabled` and calls `save()`, the forbidden operator write. Its only
  external caller is RPC `set_auto_retry` (`modes/rpc/rpc-mode.js`).

**Proposed carrier: a per-seat agent dir.** It combines two documented Pi features:

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
- `ensureTool` re-downloads rg/fd into the workspace;
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

**Where the checks sit.** There are two:

- **At startup, in the factory: fatal.** A throwing factory becomes `Failed to load extension`
  (`loadExtension`, `core/extensions/loader.js`), an error diagnostic, then `process.exit(1)` before
  the session and initial prompt (`main`, `main.js`). Pi alone would not stop: settings errors are
  only warnings (`collectSettingsDiagnostics`).
- **In every runtime, in `session_start`: a gate.** `session_start` is emitted in `bindExtensions`
  before the initial prompt and on reload, new, resume and fork (`AgentSession.bindExtensions`,
  `AgentSession.reload`, `AgentSessionRuntime`). Handler errors there are swallowed
  (`ExtensionRunner.emit` → `emitError`), so the gate acts instead of throwing:
  - the driver holds with the reason, which shows in presence as `waiting`;
  - an `input` handler returns `{ action: "handled" }`.

  `AgentSession.prompt` emits `input` and honors `handled`, so neither a typed prompt nor the
  initial prompt runs. Cotal's own sends use `sendMessage`, which is blocked by the hold.

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
- **Only `retry.enabled` is forced.** Compaction and `retry.provider.*` are copied unchanged
  (OQ 6).
- **Seat dir:** `<workspaceRoot>/.cotal/pi-agent/<name>-<lifecycleUid ?? "unmanaged">`, created with
  `mkSecretDir`, alongside the existing `.cotal/pi-sessions` (`buildLaunch`). Its location is OQ 3.
  - It is stable per (name, uid), so `--session-id` recovery reopens the same session path string.
  - Fork `parentSession` headers record seat paths (`SessionManager.forkFrom`), because Pi uses
    `resolvePath`, not `realpath` (F6, OQ 5).
- **Operator agent dir:** the launch env's `PI_CODING_AGENT_DIR` if the operator forwarded it via
  `envAllow` (`launchEnv`, `extensions/connector-core/src/launch.ts`), else
  `join(<launch HOME>, ".pi", "agent")`, with `~` expanded against that HOME.
- **win32:** dir links are junctions, and a link that cannot be made fails loudly.
- **One PR, no inert flag.**

## Plan

### Task 1: converge the seat dir in `buildLaunch`

New file `extensions/pi/src/retry-control.ts`:

```ts
export const COTAL_PI_AGENT_DIR = "COTAL_PI_AGENT_DIR";
export const PI_VERSION = "0.79.10";
export function operatorAgentDir(env: Readonly<Record<string, string | undefined>>): string;
/** Idempotent and safe against a live seat. Throws "pi connector: …". Never deletes. */
export function convergeSeatAgentDir(seatDir: string, operatorDir: string): void;
```

`convergeSeatAgentDir`:

1. **Refuse unsafe seat paths.** `lstat` `<workspaceRoot>/.cotal/pi-agent` and `seatDir`. If either
   is a symlink, throw. Then `mkSecretDir` both.
2. **Read and validate operator settings.** Read `<operatorDir>/settings.json`, or use `{}` if it is
   absent. Throw on:
   - JSON that does not parse;
   - a value that is not a plain object;
   - legacy credentials: an `apiKeys` key, or `<operatorDir>/oauth.json` existing.
     `migrateAuthToAuthJson` (`migrations.js`) would otherwise copy them into the workspace. The
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

In `piConnector.buildLaunch` (`extensions/pi/src/connector.ts`), after `env` is built and before the
persona temp dir:

- throw `pi connector: a managed Pi seat requires workspaceRoot for its Pi agent directory` when
  `workspaceRoot` is missing;
- converge the seat dir;
- set `env.PI_CODING_AGENT_DIR` and `env.COTAL_PI_AGENT_DIR` to the seat dir.

Both callers already pass `workspaceRoot`: `Manager` spawn and `cotal spawn`.

**Tests** (`pi.smoke.ts` `buildLaunch` block, temp HOME with a fake operator dir). Assert:

- the env vars are set;
- the seat settings are `{ enabled: false, maxRetries: 7 }` and other keys are kept;
- every allowlisted link exists, including a dangling `auth.json`;
- missing dirs were created in the operator dir;
- the operator `settings.json` bytes are unchanged;
- a second call leaves link inodes and a planted `pi-debug.log` intact;
- `rmSync(seatDir, { recursive: true })` leaves operator files in place;
- the `envAllow` forwarded dir is honored.

Each refusal case throws its message:

- `apiKeys`, or `oauth.json` present;
- `extensions: ["x/../../e.ts"]`;
- a relative `sessionDir`;
- a symlinked `.cotal/pi-agent`;
- a real dir at an allowlisted name;
- no `workspaceRoot`.

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

Wiring in `cotalMesh` (`extensions/pi/src/extension.ts`):

- **At startup.** On the first load only (no cached `RUNTIMES` entry), call the check with
  `process.cwd()` right after the Pi API check, before `persistSessionId`, and throw `reason` on
  failure.
- **In every runtime.** In every `session_start` (every reason), re-run the check on `ctx.cwd` and
  set a runtime `retryGate`. A closed gate calls `driver.hold(reason)`, which needs a public
  `hold(reason: string): void` on `PiDriver`. A new `pi.on("input", …)` returns
  `{ action: "handled" }` with a `ui.notify` while the gate is closed. The gate reopens only on a
  later passing `session_start`.

**Tests:**

- **Unit cases.** Project `retry` values `{enabled:true}`, `null`, `true` and `[]` fail.
  `{maxRetries:5}`, `{enabled:false}` and an unparseable file pass. A seat file with
  `enabled:true`, a mismatched dir and `hostVersion "0.80.0"` fail. With no `COTAL_PI_AGENT_DIR`,
  the check passes, which proves operator sessions are unchanged.
- **Process run.** Spawn `node <pi dist/cli.js> --extension <dist/standalone.js> -p hi` in a project
  that enables retry. Assert exit 1, stderr naming the project file, and no transcript under
  `sessions/`.
- **Process control run.** The same spawn without the project file must get past extension load.
- **SDK runtime switch.** In `pi-sdk.smoke.ts`, extend the existing
  `createAgentSessionRuntime(createRuntime, …)` replacement. Switch to a cwd whose project enables
  retry and assert:
  - the driver is held;
  - `prompt("x")` makes no provider call;
  - switching back reopens the gate.

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
  - the seat dir;
  - the refused project `retry` values and the gate;
  - that seat-pane settings changes persist only to the seat copy;
  - the runtime pin.
- **`docs/design/session-recovery.md` § 4.2.** Amend the adopted recovery-rule paragraph to match.
- **Changeset.** Add `.changeset/pi-managed-retry-off.md` (`"@cotal-ai/pi": patch`).
- **Rollout.** A seat gets the control at its next launch or supervised restart. Seats that are
  already running keep retry until then.

## Tasks

- [ ] Task 1: `operatorAgentDir`, `convergeSeatAgentDir` and the `buildLaunch` wiring, with the
  refusal and convergence tests.
- [ ] Task 2: `checkManagedRetryOff`, the startup throw, the `session_start` gate with
  `PiDriver.hold` and the `input` handler, the unit, process and runtime-switch tests.
- [ ] Task 3: merge pins, the retry-off proof, the retry-on control and the post-run compaction
  race.
- [ ] Task 4: `connect-pi.md`, `README.md`, `session-recovery.md` § 4.2 and the changeset.

## Open Questions

1. **Control mechanism (load-bearing).** This record carries (a).
   - **(a) Per-seat agent dir.** Built only from documented Pi features; costs the link overlay.
   - **(b) A Cotal launcher on the Pi SDK.** It would inject `SettingsManager.fromStorage`.
     `MainOptions` takes only factories, so `main.js` startup would have to be re-implemented
     against 0.79.10 internals.
   - **(c) An upstream Pi control.** A flag, an env var, or `willRetry` on the extension
     `agent_end`. None exists in 0.79.10, and none appears in the 1.0.2 changelog.
2. **Project override across runtimes (F1, F8).**
   - **(i) Startup throw plus a per-runtime gate (recommended).** A mid-session misconfiguration
     holds a visible seat.
   - **(ii) `--no-approve` for managed seats.** It sets `projectTrustOverride = false`
     (`cli/args.js`), which closes the gap by construction but drops project
     extensions/skills/prompts.
   - **(iii) Startup-only check plus documented risk.**

   Also: should a failed gate quit (the seat retires) rather than hold?
3. **Seat dir location and threat model (F7, security-sensitive).** Assumed: workspace `.cotal`.
   `mkSecretDir` does not lstat, and Pi seats are not sandboxed (no bwrap/landlock in
   `extensions/pi/src`). A sibling seat can therefore edit another seat's settings or links.
   - **Keep it in the workspace.** Pairs with the lstat checks and the per-runtime re-check. It is
     only the same exposure as today if seats are unconfined.
   - **Move it to a per-user private root outside the workspace.** Core has no such root today.
4. **Credentials through links (security-sensitive).** OAuth refresh shares the operator's canonical
   lock (`withLockAsync` → `lockfile.lock`, whose `realpath` defaults to true in proper-lockfile
   4.1.2). Sync `withLock` passes `realpath: false`, and so does the trust lock, so they lock
   beside the link.
   - **(i) Link (recommended).** Same boundary as today.
   - **(ii) Copy at launch.** Puts secrets in the workspace and lets refresh tokens diverge.
   - **(iii) Env-only keys.** Breaks OAuth subscriptions.
5. **Cleanup and path identity (F6).** Seat dirs are never deleted, so one accumulates per uid.
   Deleting them would require a `LaunchSpec` cleanup field, a public API change in
   `packages/core/src/connector.ts`. It would also dangle fork `parentSession` paths recorded through
   the seat dir. Options: accept the leak, or add the field and accept the dangling paths.
6. **Force `retry.provider.maxRetries: 0`?** This retry happens inside one SDK request and defaults
   to 0. Forcing it overrides only operators who opted in.
