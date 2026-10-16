// @ts-check
/**
 * Suites the smoke shards skip because they are red on main. The registry stays frozen (removing
 * a line re-shards everything below it); each entry names its tracking issue and expires, and
 * `smoke:gate-inventory` fails once `recheckBy` passes or an entry stops naming a CI suite.
 */

/** @type {Record<string, { reason: string; recheckBy: string }>} */
export const QUARANTINED = {
  "smoke:delivery-starvation": { reason: "RIG-4872: F3/F5 shard-takeover cells fail", recheckBy: "2026-11-15" },
  "smoke:upgrade-section": { reason: "RIG-4872: flaky ACCEPT CONTROL exit-reader cells", recheckBy: "2026-11-15" },
  "smoke:backup-perms:live": { reason: "RIG-4872/#643: zero-delivery consumer frontier 1 !== 2 on CI (shard 3)", recheckBy: "2026-11-15" },
  "smoke:console-control": { reason: "RIG-4922: graceful-stop cells (y, seat3 leaves) failed in mutation-reproof run 38051239634; custodian leak fixed", recheckBy: "2026-11-15" },
  "smoke:attach-reconnect": { reason: "RIG-4922: cell B (detach key mid-reconnect) failed on main CI run 38022761542 at 88546942; first failure in 25 runs", recheckBy: "2026-11-15" },
  "smoke:turn-relay-auth": { reason: "flaky: JetStream heartbeats missed on CI run 38171320196; Cotal is unmaintained, off per Matt", recheckBy: "2026-11-30" },
  "smoke:delivery-renewal": { reason: "flaky: reloadCreds no responders on CI run 38171167895; Cotal is unmaintained, off per Matt", recheckBy: "2026-11-30" },
  "smoke:codex-host": { reason: "RIG-4872: flaky; approval presence wait timed out on CI run 37970832138, passed on 37964440191", recheckBy: "2026-11-15" },
  "smoke:mutation-fixtures": { reason: "upstream: 91 dead mutation anchors on pristine main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:required-arg-seam": { reason: "upstream: call-site pins 229/179 vs 247/193 and an unverifiable tls site in control-target.ts on pristine main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:instrument-instance-pin": { reason: "upstream: red on main CI runs 38756147210 and 38753177566; 2/61 fail locally on the merge; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:seat-exit-cause": { reason: "upstream: TypeError reading allowSubscribe on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:sys-rotation-e2e": { reason: "upstream: a plain cotal up no longer reports Started nats-server on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:web-echo-escaping": { reason: "upstream: 1/29 cells fail on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:manager-reconcile-startup": { reason: "upstream: red on main CI runs 38756147210 and 38753177566; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:manager-restart-live": { reason: "upstream: red on main CI runs 38756147210 and 38753177566; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:up-tls-routes": { reason: "flaky: delivery-refresh-keeps-tls failed on #83 run 38791646907, passes locally on the merge and on main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:orphan-seat-reap": { reason: "upstream: the in-process pty runtime has no custody reference, so the smoke dies reading ready.reference.id on pristine main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:orphan-seat-spawn-window": { reason: "upstream: the in-process pty runtime has no custody reference, so the smoke dies reading ready.reference.id on pristine main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:user-auth-launch:live": { reason: "upstream: the two foreground-spawn-beyond-grant cells fail on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:claude-hosted-presence": { reason: "upstream: exits 0 with no COTAL_SMOKE_SENTINEL on pristine main 8ca93e96, so the shard grades it failed; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:claude-hosted-types": { reason: "upstream: exits 0 with no COTAL_SMOKE_SENTINEL on pristine main 8ca93e96, so the shard grades it failed; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:transport-liveness:broker": { reason: "upstream: passes its cells, then never exits on pristine main 8ca93e96 (180s local timeout; hit the 60 min shard limit on CI); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:presence-render-census": { reason: "upstream: manifest anchor `return r;` occurs twice in connector-core agent.ts on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:manager-caller-transport": { reason: "upstream: askHost cell hits a KV direct-get permissions violation on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:claude-workspace-trust": { reason: "upstream: exits 0 with no COTAL_SMOKE_SENTINEL on pristine main 8ca93e96, so the shard grades it failed; quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:orphan-seat-rollback": { reason: "upstream: finds no seat record under the custody root on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:runtime-mesh-turn": { reason: "upstream: cancel is not in the manager surface, so the Cancelled cell fails on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:manager-stop-spare-guard": { reason: "upstream: 1/26 cells fail on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:delivery-explicit-space": { reason: "upstream: ensureControlPlane explicit-space cell fails on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:claude-hosted-session": { reason: "upstream: spawnSync git ENOENT on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:cli-on-instance": { reason: "upstream: red on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:legacy-packaged-manager": { reason: "upstream: the $0-relative pnpm launcher cell fails (also red on #83 CI shard 3) on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:mint-provision:auth": { reason: "upstream: red on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:mutation-metadata": { reason: "upstream: red on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:mutation-reproof": { reason: "upstream: the snapshot-install-failure UNMEASURED cell fails on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:orphan-seat-succession": { reason: "upstream: successor manager exits 1 on static reconcile (also red on #83 CI shard 2) on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:remote-manager-goal-reader": { reason: "upstream: describe reply subscription permissions violation on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:suite-ambient-env-self": { reason: "upstream: run-owned-agents.smoke.ts reads COTAL_ env before scrubbing (also red on #83 CI shard 0) on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:up-refresh-identity:live": { reason: "upstream: red on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:jcode-provider-permanent-refusal": { reason: "flaky upstream: timed out waiting for the permanent replacement refusal on #83 CI run 38978458326; passes 3/3 locally on the merge and on pristine main; quarantined on sync per Matt", recheckBy: "2026-12-31" },
};

/** ci.yml smoke steps marked `continue-on-error`; gate-inventory requires the two sets to match. */
/** @type {Record<string, { reason: string; recheckBy: string }>} */
export const LIVE_QUARANTINED = {
  "smoke:lifecycle-e2e": { reason: "RIG-4872: despawn cannot prove a pty seat gone until RIG-4320 lands", recheckBy: "2026-11-15" },
  "smoke:schema-remaining15-diagnostic": { reason: "upstream: dynamicRef cases fail on pristine main 8ca93e96 (local run); quarantined on sync per Matt", recheckBy: "2026-12-31" },
  "smoke:herdr-e2e:live": { reason: "RIG-4872: herdr server not running when the manager starts", recheckBy: "2026-11-15" },
};
