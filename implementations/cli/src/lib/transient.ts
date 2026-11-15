import { CotalEndpoint, DEV_OWNER, EpEnvelopeError, agentCredentialLifecycleUid, channelBucket, credsClaims, isPublishPermissionDenied, mintCreds, newIdentity, parsePrincipalKey, presenceBucket, principalFromTags, subjectMatches } from "@cotal-ai/core";
import { CommandFailure, endpointAuth, type Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, connectOrThrow } from "./connect.js";
import { brokerStoreWrite, storeWriteRepair } from "./broker-store-health.js";
import { chatStreamGone, streamsAbsent } from "./space-streams.js";
import { DIAL_TIMEOUT_MS, DialNotAdmitted, dialWithRetry, notAdmittedRefusal } from "@cotal-ai/workspace/control";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolution + creds + reachability all go through
 * the shared `connectOrExit` (so these work from any directory, and an explicit `--creds` is a raw
 * off-registry connection). Opens a transient endpoint that never joins the roster, does the one
 * thing, stops. USER-mode meshes ride the same call: `connectOrExit` hands back bearer + sentinel
 * and {@link endpointAuth} spreads whichever material arrived.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; user-auth mesh →
 *  login/bearer material; else the running mesh's minted least-privilege OPERATOR creds — self-scoped
 *  publish + presence/channel read, no broad manager). Fail-loud — an unresolved registry or an
 *  unreachable/auth-mismatched broker exits with one sentence, never degrades. */
export async function resolveConnect(values: ConnectValues): Promise<Connection> {
  return connectOrExit(values, "operator");
}

/** Whether a static or open connection may read a KV bucket with a batched Direct Get. */
export function batchedRead(conn: Connection, bucket: string): boolean {
  if (conn.creds === undefined) return true;
  const subject = `$JS.API.DIRECT.GET.KV_${bucket}`;
  const pub = credsClaims(conn.creds).nats?.pub;
  return (pub?.allow ?? []).some((row) => subjectMatches(row, subject)) && !(pub?.deny ?? []).some((row) => subjectMatches(row, subject));
}

/** A JetStream request that no responder answered: the stream it names is not on the broker, or the
 *  broker's JetStream is stopped. */
function noResponders(e: unknown): boolean {
  return e instanceof Error && e.name === "JetStreamStatusError" && String((e as { code?: unknown }).code) === "503";
}

/** Whether the chat stream of `conn`'s space is gone, asked over a connection of its own that reads
 *  nothing else: an endpoint whose start failed keeps no connection to ask on. The stream's info is
 *  an observer's read, which a sender may not ask, so this machine mints an observer from the
 *  space's trust material as `status` does; without it the connection's own credential asks. A
 *  connection that cannot start or ask answers no. */
async function chatStreamGoneAt(conn: Connection): Promise<boolean> {
  let probe: CotalEndpoint | undefined;
  try {
    const id = newIdentity();
    const auth = conn.auth ? { creds: await mintCreds(conn.auth, id, "observer"), ...(conn.tls ? { tls: true } : {}) } : endpointAuth(conn);
    probe = new CotalEndpoint({ space: conn.space, servers: conn.server, ...auth, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { ...(conn.auth ? { id: id.id } : {}), name: "stream-probe", kind: "endpoint" } });
    probe.on("error", () => {});
    probe.on("warning", () => {});
    await probe.start();
    return await chatStreamGone(probe);
  } catch {
    return false;
  } finally {
    await probe?.stop().catch(() => {});
  }
}

/** The refusal for a space whose broker answered no read of it while its chat stream was not found
 *  missing. nats-server stops JetStream after a store write it could not make and keeps the streams in
 *  its store, so the write failure this machine's broker logged names the cause and the repair. */
function jetStreamUnanswered(conn: Connection): CommandFailure {
  const failed = conn.root ? brokerStoreWrite(conn.root, conn.space) : undefined;
  if (failed?.state === "write-failed")
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker of ${conn.space} has answered no JetStream request since it logged a store write failure at ${failed.at}: ${failed.cause}${failed.path ? ` (${failed.path})` : ""}; nats-server stops JetStream after such a write and keeps the streams and their history in its store`, {
      target: { space: conn.space },
      remedy: `${storeWriteRepair(failed, conn.root, conn.space)}, then restart the broker with \`cotal down --yes\` and \`cotal up\` in ${conn.root}, which keeps the history`,
    });
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker of ${conn.space} answered no JetStream read, and the space's streams were not found missing`, { target: { space: conn.space }, remedy: "run `cotal status`, which names a store write failure its broker logged on this machine" });
}

/** Open a transient endpoint with a roster and optional channel registry. User-mode reads the
 *  roster through auth; other connections use the direct read or an explicitly requested watch. */
export async function openTransient(
  values: ConnectValues,
  name: string,
  opts: { throwOnRefusal?: boolean; senderActor?: string; watch?: boolean; presenceOnly?: boolean; report?: (level: "error" | "warning", e: Error) => void } = {},
): Promise<{ ep: CotalEndpoint; space: string; connection: Connection }> {
  const conn = opts.throwOnRefusal ? await connectOrThrow(values, "operator", { operatorActor: opts.senderActor }) : await resolveConnect(values);
  const claims = values.creds && conn.creds ? credsClaims(conn.creds) : undefined;
  const grants = claims?.nats?.pub?.allow ?? [];
  const credentialUid = values.creds && conn.creds ? agentCredentialLifecycleUid(conn.creds, conn.space) : undefined;
  const watchSubject = `$JS.API.CONSUMER.CREATE.KV_${presenceBucket(conn.space)}.>`;
  const canWatch = grants.some((row) => subjectMatches(row, watchSubject));
  const managerRoster = credentialUid !== undefined;
  if (claims && !managerRoster && !canWatch && !batchedRead(conn, presenceBucket(conn.space)))
    throw new CommandFailure("refused", "PERMISSION_DENIED", `this credential cannot read the roster in ${conn.space}`, { target: { space: conn.space }, remedy: "use an operator or observer credential with presence access" });
  let credentialPrincipal: { owner: string; actor: string } | undefined;
  if (managerRoster) {
    const remedy = "run it inside the agent session or use an operator credential";
    if (grants.some((subject) => subject.includes(".ep.v1.one.")))
      throw new CommandFailure("refused", "PERMISSION_DENIED", "an issued agent credential cannot read the roster from a one-shot CLI call", { target: { space: conn.space }, remedy });
    const key = principalFromTags(claims?.nats?.tags);
    const principal = key === null ? null : parsePrincipalKey(key);
    if (!principal) throw new CommandFailure("refused", "PERMISSION_DENIED", "the agent credential has no valid principal tag", { target: { space: conn.space }, remedy });
    credentialPrincipal = { owner: principal.owner, actor: principal.actor };
  }
  // Explicit agent credentials carry their minted principal in the shared static-identity tag.
  // Otherwise match the principal minted by this connection's account signer.
  const senderPrincipal = credentialPrincipal ?? (opts.senderActor !== undefined && conn.auth && conn.creds
    ? { owner: DEV_OWNER, actor: opts.senderActor } : undefined);
  const rosterRead = managerRoster || conn.bearer !== undefined || batchedRead(conn, presenceBucket(conn.space));
  const readOnce = rosterRead && batchedRead(conn, channelBucket(conn.space));
  const once = managerRoster || (!opts.watch && (opts.presenceOnly ? rosterRead : readOnce));
  const report = opts.report ?? ((level, e) => console.error(level === "error" ? c.red("! " + e.message) : c.yellow("! " + e.message)));
  // A connect the broker refuses or does not complete in time sends nothing, so it is tried again
  // with a new endpoint. What a failed attempt reported is dropped with it; a failure after the
  // connection opened is not retried and reaches the handling below as it was.
  let ep!: CotalEndpoint;
  try {
    ep = await dialWithRetry(async () => {
      let opened = false;
      const held: ["error" | "warning", Error][] = [];
      const attempt = new CotalEndpoint({
        space: conn.space,
        servers: conn.server,
        ...endpointAuth(conn),
        ...((conn.epCaller?.uid ?? credentialUid) ? { lifecycleUid: conn.epCaller?.uid ?? credentialUid } : {}),
        ...(managerRoster ? { managerRoster: true } : {}),
        channels: [],
        consume: false,
        registerPresence: false,
        watchPresence: true,
        watchChannels: !opts.presenceOnly,
        readOnce: once,
        transportConnectTimeoutMs: DIAL_TIMEOUT_MS,
        onConnection: () => { opened = true; },
        // Display name only. The wire principal comes from the resolved static credential or user
        // bearer; on an open mesh the endpoint self-mints it. Process environment never supplies
        // authority for an operator command.
        card: { name, kind: "endpoint", ...senderPrincipal },
      });
      attempt.on("error", (e: Error) => { if (opened) report("error", e); else held.push(["error", e]); });
      attempt.on("warning", (e: Error) => { if (opened) report("warning", e); else held.push(["warning", e]); });
      try {
        await attempt.start();
        if (!once && !opts.watch) await attempt.waitForPresenceSnapshot();
      } catch (e) {
        await attempt.stop().catch(() => {});
        throw opened ? new AfterOpen(e) : e;
      }
      for (const [level, e] of held) report(level, e);
      return attempt;
    });
  } catch (raw) {
    if (raw instanceof DialNotAdmitted) throw notAdmittedRefusal(raw, `space "${conn.space}"`, "nothing was sent", { space: conn.space }, conn.mode === "user");
    const e = raw instanceof AfterOpen ? raw.cause : raw;
    if (managerRoster && e instanceof Error && ((e instanceof EpEnvelopeError && e.code === "unavailable" && e.outcome === "not-executed" && e.message.includes("no responder for manager.roster")) || e.message.startsWith("manager.roster refused:"))) throw new CommandFailure("refused", "PERMISSION_DENIED", `the agent credential could not read the roster from manager: ${e.message}`, { target: { space: conn.space }, remedy: "start a manager for this space, or use an operator credential" });
    if (managerRoster && e instanceof EpEnvelopeError && e.code === "deadline-exceeded" && e.message.includes("no describe reply from manager"))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `manager.roster discovery did not answer: ${e.message}`, { target: { space: conn.space } });
    if (conn.bearer === undefined && !opts.watch && isPublishPermissionDenied(e))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read the presence or channel registry of ${conn.space}: ${(e as Error).message}`, {
        target: { space: conn.space },
        remedy: values.creds === undefined ? `use a credential that may read both in ${conn.space}` : `run it without --creds to use the credential this machine records for ${conn.space}, or use one that may read both`,
      });
    if (conn.bearer !== undefined && once && isPublishPermissionDenied(e))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the connection the auth service of ${conn.space} minted for your user could not read the roster or channel registry: ${(e as Error).message}`, {
        target: { space: conn.space },
        remedy: `update the auth service of ${conn.space} and mint a new credential`,
      });
    // A one-time read is a Direct Get, which nothing answers when the bucket's stream is gone, and
    // nothing answers either while the broker's JetStream is stopped, as nats-server stops it after a
    // store write it could not make. Only the chat stream's own not-found says the streams are gone.
    if (once && noResponders(e)) throw await chatStreamGoneAt(conn) ? streamsAbsent(conn) : jetStreamUnanswered(conn);
    throw e;
  }
  return { ep, space: conn.space, connection: conn };
}

/** A failure after the transient endpoint's connection opened, which is not a refused or timed-out
 *  connect and is not retried. */
class AfterOpen extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
