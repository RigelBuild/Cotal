import assert from "node:assert/strict";
import { test } from "node:test";
import { createRosterSnapshotCache } from "../dist/roster-service.js";

function row(id) {
  return { card: { id, name: id, kind: "agent" }, status: "idle" };
}

test("a reconnect starts a fresh scan instead of reusing the old connection's flight", async () => {
  let releaseA;
  const connectionA = { isClosed: () => false };
  const connectionB = { isClosed: () => false };
  let active = connectionA;
  const scans = [];
  const cache = createRosterSnapshotCache(
    () => active,
    (connection) => {
      scans.push(connection);
      if (connection === connectionA) return new Promise((resolve) => { releaseA = resolve; });
      return Promise.resolve([row("connection-b")]);
    },
    () => {},
  );

  const readA = cache.read();
  assert.equal(typeof releaseA, "function", "the first scan must be held open");
  active = connectionB;
  const readB = cache.read();
  releaseA([row("connection-a")]);
  await assert.rejects(readA, /connection changed during the read/);
  const rowsB = await readB;
  assert.deepEqual(scans, [connectionA, connectionB], "reconnect starts a scan on the new connection");
  assert.deepEqual(rowsB, [row("connection-b")], "the reconnect read resolves with the new connection's rows");
});
