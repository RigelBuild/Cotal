/**
 * The Unix-socket forwarder to the Go reconciler. One connection carries one request and one
 * reply, each one JSON line of at most 1 MiB. Every transport failure is `unavailable`.
 */
import { createConnection } from "node:net";
import { EP_ERROR_CODES, EpEnvelopeError, type EpErrorCode, type ParsedEpRequest } from "@cotal-ai/core";

export const MAX_WIRE_BYTES = 1024 * 1024;
export const DEFAULT_SOCKET_DEADLINE_MS = 30_000;

const unavailable = (why: string): EpEnvelopeError => new EpEnvelopeError("unavailable", `reconciler ${why}`);

const isErrorCode = (code: unknown): code is EpErrorCode => (EP_ERROR_CODES as readonly unknown[]).includes(code);

/** Map one parsed reply line to its result, or throw the reconciler's error or `unavailable`. */
function settleReply(line: string): unknown {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    throw unavailable("reply is not JSON");
  }
  if (typeof reply !== "object" || reply === null || !("v" in reply) || reply.v !== 1 || !("ok" in reply))
    throw unavailable("reply is not a v1 reply");
  if (reply.ok === true && "result" in reply && typeof reply.result === "object" && reply.result !== null && !Array.isArray(reply.result))
    return reply.result;
  if (reply.ok === false && "error" in reply && typeof reply.error === "object" && reply.error !== null) {
    const { code, message } = reply.error as { code?: unknown; message?: unknown };
    if (isErrorCode(code) && typeof message === "string") throw new EpEnvelopeError(code, message);
  }
  throw unavailable("reply is malformed");
}

/** Send one request for `subject` and `args` to the socket, and return the reconciler's result. */
export function forwardToReconciler(socketPath: string, subject: ParsedEpRequest, args: unknown, deadlineMs: number): Promise<unknown> {
  const line = `${JSON.stringify({ v: 1, command: `${subject.endpoint}.${subject.command}`, subject, args })}\n`;
  if (Buffer.byteLength(line) > MAX_WIRE_BYTES) return Promise.reject(unavailable("request is over 1 MiB"));
  // The repo targets ES2023 lib, so Promise.withResolvers is unavailable.
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const sock = createConnection(socketPath);
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const finish = (settle: () => void): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sock.destroy();
    settle();
  };
  const fail = (why: string) => finish(() => reject(unavailable(why)));
  const timer = setTimeout(() => fail("reply passed the socket deadline"), deadlineMs);
  sock.on("error", () => fail("socket is unreachable"));
  sock.on("connect", () => sock.write(line));
  sock.on("data", (chunk: Buffer) => {
    const end = chunk.indexOf(0x0a);
    size += end < 0 ? chunk.length : end;
    if (size > MAX_WIRE_BYTES) return fail("reply is over 1 MiB");
    if (end < 0) return void chunks.push(chunk);
    chunks.push(chunk.subarray(0, end));
    const reply = Buffer.concat(chunks).toString("utf8");
    finish(() => {
      try {
        resolve(settleReply(reply));
      } catch (e) {
        reject(e);
      }
    });
  });
  sock.on("end", () => fail("closed the socket without a reply"));
  sock.on("close", () => fail("closed the socket without a reply"));
  return promise;
}
