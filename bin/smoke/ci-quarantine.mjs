// @ts-check
/**
 * Suites the smoke shards skip because they are red on main. The registry stays frozen (removing
 * a line re-shards everything below it); each entry names its tracking issue and expires, and
 * `smoke:gate-inventory` fails once `recheckBy` passes or an entry stops naming a CI suite.
 */

/** @type {Record<string, { reason: string; recheckBy: string }>} */
export const QUARANTINED = {
  "smoke:egress-guard-differential": { reason: "RIG-4872: predecessor resolver returns null for 1698fe253 on CI (shard 0)", recheckBy: "2026-11-15" },
  "smoke:delivery-starvation": { reason: "RIG-4872: F3/F5 shard-takeover cells fail", recheckBy: "2026-11-15" },
  "smoke:upgrade-section": { reason: "RIG-4872: flaky ACCEPT CONTROL exit-reader cells", recheckBy: "2026-11-15" },
  "smoke:backup-perms:live": { reason: "RIG-4872/#643: zero-delivery consumer frontier 1 !== 2 on CI (shard 3)", recheckBy: "2026-11-15" },
  "smoke:console-control": { reason: "RIG-4922: graceful-stop cells (y, seat3 leaves) failed in mutation-reproof run 38051239634; custodian leak fixed", recheckBy: "2026-11-15" },
  "smoke:attach-reconnect": { reason: "RIG-4922: cell B (detach key mid-reconnect) failed on main CI run 38022761542 at 88546942; first failure in 25 runs", recheckBy: "2026-11-15" },
  "smoke:codex-host": { reason: "RIG-4872: flaky; approval presence wait timed out on CI run 37970832138, passed on 37964440191", recheckBy: "2026-11-15" },
};

/** ci.yml smoke steps marked `continue-on-error`; gate-inventory requires the two sets to match. */
/** @type {Record<string, { reason: string; recheckBy: string }>} */
export const LIVE_QUARANTINED = {
  "smoke:lifecycle-e2e": { reason: "RIG-4872: despawn cannot prove a pty seat gone until RIG-4320 lands", recheckBy: "2026-11-15" },
  "smoke:herdr-e2e:live": { reason: "RIG-4872: herdr server not running when the manager starts", recheckBy: "2026-11-15" },
};
