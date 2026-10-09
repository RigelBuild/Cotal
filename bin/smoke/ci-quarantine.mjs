// @ts-check
/**
 * Suites the smoke shards skip because they are red on main. The registry stays frozen (removing
 * a line re-shards everything below it); each entry names its tracking issue and expires, and
 * `smoke:gate-inventory` fails once `recheckBy` passes or an entry stops naming a CI suite.
 */

/** @type {Record<string, { reason: string; recheckBy: string }>} */
export const QUARANTINED = {
  "smoke:npm-publish-preflight": { reason: "RIG-4872: repository-entrypoint census cells fail on CI (shard 3)", recheckBy: "2026-11-15" },
  "smoke:egress-guard-differential": { reason: "RIG-4872: predecessor resolver returns null for 1698fe253 on CI (shard 0)", recheckBy: "2026-11-15" },
  "smoke:seat-orphan": { reason: "RIG-4872: one-byte-past-limit truncation cell fails", recheckBy: "2026-11-15" },
  "smoke:delivery-starvation": { reason: "RIG-4872: F3/F5 shard-takeover cells fail", recheckBy: "2026-11-15" },
  "smoke:codex-events-lifecycle": { reason: "RIG-4872: broker-outage IDLE setup cells fail", recheckBy: "2026-11-15" },
  "smoke:presence-render-census": { reason: "RIG-4872: manifest anchor no longer present in cli down.ts", recheckBy: "2026-11-15" },
  "smoke:manager-stop-spare-guard": { reason: "RIG-4872: live-PTY spare-stop census and frozen #1343 inventory are stale", recheckBy: "2026-11-15" },
  "smoke:upgrade-section": { reason: "RIG-4872: flaky ACCEPT CONTROL exit-reader cells", recheckBy: "2026-11-15" },
};
