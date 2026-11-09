/**
 * Reading a pre-minted agent credential for a foreground `cotal spawn --creds`.
 *
 * The launch holds no account signing seed, so it cannot mint or provision anything. Everything it
 * needs comes from the credential itself: the identity is the JWT subject, and the lifecycle UID and
 * the control-plane capabilities are recovered by rebuilding the rows `permissionsFor` would mint and
 * checking that the credential carries them. No subject string is written here; the builders own them.
 */
import {
  DEV_OWNER,
  credsClaims,
  dmDurable,
  epCallerGrantRows,
  idFromCreds,
  operatorInstrumentCapabilities,
  permissionsFor,
  runCallerCapabilities,
  spawnCallerCapabilities,
  type EpCapability,
} from "@cotal-ai/core";

/** What a pre-minted credential grants the launch that presents it. */
export interface CredentialGrant {
  /** The credential's nkey: the JWT subject, checked against the seed it carries. */
  id: string;
  /** The capability names whose full row set the credential holds. */
  capabilities: string[];
}

/** Each capability `permissionsFor` mints, with the EP capability set that becomes its rows. */
const CAPABILITY_SETS: ReadonlyArray<readonly [name: string, caps: (owner: string) => EpCapability[]]> = [
  ["spawn", spawnCallerCapabilities],
  ["run", runCallerCapabilities],
  ["admin", (owner) => operatorInstrumentCapabilities("admin", owner)],
];

/** The publish-allow rows of a `permissionsFor` result, read without trusting its shape. */
function publishAllow(perms: Record<string, unknown>): string[] {
  const pub = perms.pub;
  if (typeof pub !== "object" || pub === null || !("allow" in pub)) return [];
  const allow = pub.allow;
  return Array.isArray(allow) ? allow.filter((row): row is string => typeof row === "string") : [];
}

/**
 * The capabilities a static agent credential holds, by reversing `permissionsFor`: a capability counts
 * only when every row its EP set mints for this caller is present. Rows that match no set add nothing,
 * so an unrecognised credential yields an empty list rather than an error.
 */
export function credentialCapabilities(pubAllow: readonly string[], space: string, actor: string, lifecycleUid: string): string[] {
  const held = new Set(pubAllow);
  const caller = { owner: DEV_OWNER, actor, uid: lifecycleUid };
  return CAPABILITY_SETS.filter(([, caps]) => {
    const rows = epCallerGrantRows(space, caps(DEV_OWNER), caller).pub;
    return rows.length > 0 && rows.every((row) => held.has(row));
  }).map(([name]) => name);
}

/**
 * Read a pre-minted static agent credential for `space` at `lifecycleUid`, or throw one sentence.
 *
 * The lifecycle check rebuilds the agent profile's DM durable rows (`dm_<owner>-<actor>-<uid>`) for the
 * given UID. A credential minted for another incarnation or another space does not carry them, and a
 * launch with that UID would bind durables the broker refuses.
 */
export function readCredentialGrant(creds: string, space: string, lifecycleUid: string): CredentialGrant {
  const id = idFromCreds(creds);
  const allow = credsClaims(creds).nats?.pub?.allow ?? [];
  const dm = dmDurable(DEV_OWNER, id, lifecycleUid);
  const expected = publishAllow(
    permissionsFor("agent", space, { owner: DEV_OWNER, actor: id, connId: id, lifecycleUid }, {}),
  ).filter((row) => row.includes(dm));
  const held = new Set(allow);
  if (expected.length === 0 || !expected.every((row) => held.has(row)))
    throw new Error(
      `the credential's grants do not name lifecycle ${lifecycleUid} in space "${space}" (no ${dm} durable) - pass the --lifecycle-uid minted with this credential, and the --space it was minted for`,
    );
  return { id, capabilities: credentialCapabilities(allow, space, id, lifecycleUid) };
}
