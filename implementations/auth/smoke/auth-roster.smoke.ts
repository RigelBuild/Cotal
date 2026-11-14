import assert from "node:assert/strict";
import type { Presence } from "@cotal-ai/core";
import { answerAuthRoster, createRosterSnapshotCache } from "@cotal-ai/core";

const row = (id: string, activity: string): Presence => ({ card: { id, name: id, kind: "agent" }, status: "idle", ts: Date.now(), activity });
const rows = [row("a", "x".repeat(1000)), row("b", "live")];
let drops = 0;
const reader = { read: async () => rows, dropOversized: () => { drops++; } };
const page = await answerAuthRoster(reader, { replyFits: (data) => JSON.stringify(data).length < 500 }, {});
assert.deepEqual(page.rows.map((entry) => entry.card.id), ["b"]);
assert.equal(drops, 1);
console.log("auth roster drops oversized rows and returns the remaining peer");

const ordered = [row("a", ""), row("b", ""), row("c", "")];
const orderedReader = { read: async () => ordered, dropOversized: () => {} };
for (const [after, expected] of [["a", ["b", "c"]], ["b", ["c"]], ["0", ["a", "b", "c"]], ["c", []], ["z", []]] as const) {
  const result = await answerAuthRoster(orderedReader, {}, { after });
  assert.deepEqual(result.rows.map((entry) => entry.card.id), expected, `after ${after}`);
  assert.equal(result.next, undefined, `after ${after} ends the roster`);
}
let after: string | undefined;
for (const [id, next] of [["a", "a"], ["b", "b"], ["c", undefined]] as const) {
  const result = await answerAuthRoster(orderedReader, {}, { limit: 1, ...(after === undefined ? {} : { after }) });
  assert.deepEqual(result.rows.map((entry) => entry.card.id), [id]);
  assert.equal(result.next, next);
  after = result.next;
}

const first = { isClosed: () => false }, second = { isClosed: () => false };
let connection = first, scans = 0;
const cache = createRosterSnapshotCache(() => connection, async () => { scans++; return rows; }, () => {});
await cache.read(); await cache.read();
assert.equal(scans, 1, "same connection uses the cached snapshot");
connection = second;
await cache.read();
assert.equal(scans, 2, "a new connection starts a new scan");
let release: (() => void) | undefined;
const slow = createRosterSnapshotCache(() => connection, async () => { await new Promise<void>((resolve) => { release = resolve; }); return rows; }, () => {});
const pending = slow.read();
connection = first;
release?.();
await assert.rejects(pending, /connection changed/);
