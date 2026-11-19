/**
 * A stand-in for the Go reconciler's socket. One request and one reply per connection. `received`
 * records each request the shim sent, after it parses as one v1 JSON line.
 */
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";

export type FakeBehaviour = "ok" | "refuse" | "unknown-code" | "malformed" | "non-object-result" | "oversized" | "silent";

const WireRequest = z.object({
  v: z.literal(1),
  command: z.string(),
  subject: z.object({
    route: z.string(),
    endpoint: z.string(),
    command: z.string(),
    target: z.unknown(),
    caller: z.object({ owner: z.string(), actor: z.string(), uid: z.string() }).loose(),
    nonce: z.string(),
  }).loose(),
  args: z.record(z.string(), z.unknown()),
});
export type WireRequest = z.infer<typeof WireRequest>;

export interface FakeReconciler {
  readonly socketPath: string;
  readonly received: WireRequest[];
  /** Connections still open from the shim. */
  openSockets(): number;
  setBehaviour(next: FakeBehaviour): void;
  /** Stop listening and remove the socket, so a dial fails as unreachable. */
  down(): Promise<void>;
  /** Listen on the socket again. */
  up(): Promise<void>;
  close(): Promise<void>;
}

const OVERSIZED_BYTES = 1024 * 1024 + 1;

/** Start the stand-in on `dir/reconciler.sock`. */
export async function startFakeReconciler(dir: string): Promise<FakeReconciler> {
  const socketPath = join(dir, "reconciler.sock");
  const received: WireRequest[] = [];
  const sockets = new Set<Socket>();
  let behaviour: FakeBehaviour = "ok";
  let server: Server | undefined;

  const reply = (sock: Socket, request: WireRequest): void => {
    switch (behaviour) {
      case "ok":
        sock.end(`${JSON.stringify({ v: 1, ok: true, result: { revision: 7, command: request.command } })}\n`);
        return;
      case "refuse":
        sock.end(`${JSON.stringify({ v: 1, ok: false, error: { code: "permission-denied", message: "seat not yours" } })}\n`);
        return;
      case "unknown-code":
        sock.end(`${JSON.stringify({ v: 1, ok: false, error: { code: "invalid-argument", message: "no such code" } })}\n`);
        return;
      case "non-object-result":
        sock.end(`${JSON.stringify({ v: 1, ok: true, result: null })}\n`);
        return;
      case "malformed":
        sock.end("not json\n");
        return;
      case "oversized":
        sock.end(`${"a".repeat(OVERSIZED_BYTES)}\n`);
        return;
      case "silent":
        return;
    }
  };

  const onConnection = (sock: Socket): void => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const end = buf.indexOf("\n");
      if (end < 0) return;
      const line = buf.slice(0, end);
      buf = "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      const request = WireRequest.safeParse(parsed);
      if (!request.success) {
        sock.destroy();
        return;
      }
      received.push(request.data);
      reply(sock, request.data);
    });
  };

  // The repo targets ES2023 lib, so Promise.withResolvers is unavailable.
  const up = (): Promise<void> => {
    rmSync(socketPath, { force: true });
    const next = createServer(onConnection);
    return new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(socketPath, () => {
        server = next;
        resolve();
      });
    });
  };

  const down = async (): Promise<void> => {
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    const current = server;
    server = undefined;
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    rmSync(socketPath, { force: true });
  };

  await up();
  return {
    socketPath,
    received,
    openSockets: () => sockets.size,
    setBehaviour(next) {
      behaviour = next;
    },
    down,
    up,
    close: down,
  };
}
