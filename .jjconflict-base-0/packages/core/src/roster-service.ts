import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { AUTH_ROSTER_PAGE_BYTES, AUTH_ROSTER_PAGE_LIMIT } from "./roster-contract.js";
import type { AuthRosterInput, AuthRosterOutput } from "./roster-contract.js";
import { DEFAULT_HEARTBEAT_MS } from "./presence-heartbeat.js";
import { CotalEndpoint } from "./endpoint.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import type { EpServeContext } from "./endpoint-serve.js";
import { TTL_RECONCILE_CANARY_KEY } from "./streams.js";
import { lastKvEntries } from "./kv-scan.js";
import { mintCreds } from "./provision.js";
import { newIdentity } from "./identity.js";
import type { SpaceAuth } from "./provision.js";
import { parsePresenceRow, presenceBucket } from "./subjects.js";
import type { Presence } from "./types.js";

export const AUTH_ROSTER_PROFILE = "auth-roster-reader";

export interface RosterReader {
  read(): Promise<Presence[]>;
  dropOversized(id: string): void;
  close(): Promise<void>;
}

export async function openAuthRosterReader(opts: {
  server: string;
  space: string;
  auth: SpaceAuth;
  log: (line: string) => void;
  onConnection?: (nc: NatsConnection, label: string) => void;
}): Promise<RosterReader> {
  const identity = newIdentity();
  const auth = opts.auth;
  let nc: NatsConnection | undefined;
  const endpoint = new CotalEndpoint({
    space: opts.space, servers: opts.server, channels: [], consume: false,
    registerPresence: false, watchPresence: false, watchChannels: false,
    card: { id: identity.id, name: AUTH_ROSTER_PROFILE, kind: "endpoint" },
    creds: () => mintCreds(auth, identity, AUTH_ROSTER_PROFILE),
    onConnection: (connection) => { nc = connection; opts.onConnection?.(connection, `cotal:${AUTH_ROSTER_PROFILE}:${opts.space}`); },
  });
  endpoint.on("error", (error: Error) => opts.log(`auth roster reader error: ${error.message}`));
  endpoint.on("warning", (error: Error) => opts.log(`auth roster reader warning: ${error.message}`));
  try {
    await endpoint.start();
    if (!nc) throw new Error("roster reader has no connection");
    // Probe bucket binding at startup; reads rebind to the current connection.
    await new Kvm(nc).open(presenceBucket(opts.space));
  } catch (error) {
    await endpoint.stop();
    throw error;
  }
  const cache = createRosterSnapshotCache(() => nc, async (connection) => {
    const kv = await new Kvm(connection).open(presenceBucket(opts.space));
    const entries = await lastKvEntries(kv);
    const rows: Presence[] = [];
    for (const entry of entries) {
      if (entry.key === TTL_RECONCILE_CANARY_KEY || entry.operation === "DEL" || entry.operation === "PURGE") continue;
      const row = parsePresenceRow(entry.string(), entry.key);
      if (row) rows.push(row);
    }
    return rows;
  }, opts.log, () => { dropped.clear(); });
  let oversizedDrops = 0;
  const dropped = new Set<string>();
  return {
    read: cache.read,
    dropOversized(id) {
      if (dropped.has(id)) return;
      dropped.add(id);
      oversizedDrops++;
      opts.log(`auth roster reader dropped oversized row ${id} (total ${oversizedDrops})`);
    },
    close: async () => { await endpoint.stop(); },
  };
}

/** Cache one complete scan, invalidating it when its transport changes. */
export function createRosterSnapshotCache<T extends { isClosed(): boolean }>(current: () => T | undefined, scan: (connection: T) => Promise<Presence[]>, log: (line: string) => void, onSnapshot: () => void = () => {}): { read(): Promise<Presence[]> } {
  let pending: { connection: T; promise: Promise<Presence[]> } | undefined;
  let snapshot: { rows: Presence[]; expires: number; connection: T } | undefined;
  return { read() {
    const connection = current();
    if (!connection || connection.isClosed()) return Promise.reject(new Error("roster reader connection is unavailable"));
    if (snapshot && snapshot.connection === connection && Date.now() < snapshot.expires) return Promise.resolve(snapshot.rows);
    if (pending?.connection === connection) return pending.promise;
    const flight = (async () => {
      const rows = await scan(connection);
      if (current() !== connection || connection.isClosed()) throw new Error("roster reader connection changed during the read");
      rows.sort((a, b) => a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0);
      snapshot = { rows, expires: Date.now() + DEFAULT_HEARTBEAT_MS / 2, connection };
      onSnapshot();
      return rows;
    })().catch((error: unknown) => {
      log(`auth roster reader scan failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    const flightState = { connection, promise: flight };
    pending = flightState;
    const settle = () => { if (pending === flightState) pending = undefined; };
    flight.then(settle, settle);
    return flight;
  } };
}

/** The reader returns rows sorted by card.id in ascending code-unit order. */
export async function answerAuthRoster(
  reader: { read(): Promise<Presence[]>; dropOversized(id: string): void },
  ctx: Pick<EpServeContext, "replyFits">,
  input: AuthRosterInput,
): Promise<AuthRosterOutput> {
  let roster: Presence[];
  try { roster = await reader.read(); }
  catch (error) {
    throw new EpEnvelopeError("unavailable", `the roster service could not read presence: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = roster;
  const rows: Presence[] = [];
  let index = 0;
  if (input.after !== undefined) {
    let end = candidates.length;
    while (index < end) {
      const middle = Math.floor((index + end) / 2);
      if (candidates[middle]!.card.id <= input.after) index = middle + 1;
      else end = middle;
    }
  }
  while (index < candidates.length) {
    const remaining = Math.min(input.limit ?? AUTH_ROSTER_PAGE_LIMIT, candidates.length - index);
    let low = 0, high = remaining;
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      const selected = candidates.slice(index, index + count);
      const last = selected[selected.length - 1]!;
      if (!ctx.replyFits || ctx.replyFits({ rows: selected, next: last.card.id }, AUTH_ROSTER_PAGE_BYTES)) low = count;
      else high = count - 1;
    }
    if (low === 0) { reader.dropOversized(candidates[index]!.card.id); index++; continue; }
    rows.push(...candidates.slice(index, index + low));
    index += low;
    if (index < candidates.length) return { rows, next: rows[rows.length - 1]!.card.id };
    break;
  }
  return { rows };
}
