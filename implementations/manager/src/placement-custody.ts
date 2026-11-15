import { createHash } from "node:crypto";
import type { SecretStore } from "@cotal-ai/core";

/** Authenticated encryption supplied by the manager's private storage composition. */
export interface PlacementTokenCipher {
  encrypt(actorToken: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export type PlacementTokenCustodyErrorCode = "conflict" | "corrupt" | "unavailable";

/** Safe, static errors. Token, ciphertext, and adapter errors are never attached. */
export class PlacementTokenCustodyError extends Error {
  constructor(readonly code: PlacementTokenCustodyErrorCode, message: string) {
    super(message);
    this.name = "PlacementTokenCustodyError";
  }
}

interface EncryptedPlacementTokenRecord {
  readonly version: 1;
  readonly actorTokenHash: string;
  readonly ciphertext: string;
}

const digestPattern = /^[a-f0-9]{64}$/;
const keyPrefix = "manager.placement.actor-token.";

export function hashPlacementActorToken(actorToken: string): string {
  return createHash("sha256").update(actorToken, "utf8").digest("hex");
}

/** Manager-only custody API for the placement enrollment operation. */
export interface PlacementTokenCustody {
  /** Durably retain before enrollment. Same operation replays only for the same token and hash. */
  retain(enrollmentOperationId: string, actorToken: string, actorTokenHash: string): Promise<void>;
  /** Recover a retained token only when its original hash is supplied. */
  recover(enrollmentOperationId: string, actorTokenHash: string): Promise<string | undefined>;
  /** Call only after an explicit terminal enrollment refusal. */
  terminalRefusal(enrollmentOperationId: string, actorTokenHash: string): Promise<void>;
  /** Call only after the associated enrollment lifecycle is retired. */
  retire(enrollmentOperationId: string, actorTokenHash: string): Promise<void>;
}

function isEncryptedPlacementTokenRecord(value: unknown): value is EncryptedPlacementTokenRecord {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "actorTokenHash" in value && typeof value.actorTokenHash === "string" && digestPattern.test(value.actorTokenHash) &&
    "ciphertext" in value && typeof value.ciphertext === "string" && value.ciphertext.length > 0;
}

function operationKey(enrollmentOperationId: string): string {
  const operationDigest = createHash("sha256").update(enrollmentOperationId, "utf8").digest("hex");
  return `${keyPrefix}${operationDigest}`;
}

function requireCoordinates(enrollmentOperationId: string, actorTokenHash: string): void {
  if (enrollmentOperationId.length === 0 || !digestPattern.test(actorTokenHash)) {
    throw new PlacementTokenCustodyError("conflict", "placement token custody coordinates are invalid");
  }
}

async function readRecord(store: SecretStore, enrollmentOperationId: string): Promise<unknown> {
  let encoded: string | undefined;
  try {
    encoded = await store.get(operationKey(enrollmentOperationId));
  } catch {
    throw new PlacementTokenCustodyError("unavailable", "placement token custody store is unavailable");
  }
  if (encoded === undefined) return undefined;

  try {
    return JSON.parse(encoded);
  } catch {
    throw new PlacementTokenCustodyError("corrupt", "placement token custody record is invalid");
  }
}

/** Creates a placement-specific custody seam over the manager's injected encrypted SecretStore. */
export function createPlacementTokenCustody(
  store: SecretStore,
  cipher: PlacementTokenCipher,
): PlacementTokenCustody {
  const open = async (recordValue: unknown, expectedHash: string): Promise<string> => {
    if (!isEncryptedPlacementTokenRecord(recordValue)) {
      throw new PlacementTokenCustodyError("corrupt", "placement token custody record is invalid");
    }
    if (recordValue.actorTokenHash !== expectedHash) {
      throw new PlacementTokenCustodyError("conflict", "placement operation already has a different actor token hash");
    }

    let actorToken: unknown;
    try {
      actorToken = await cipher.decrypt(recordValue.ciphertext);
    } catch {
      throw new PlacementTokenCustodyError("corrupt", "placement token custody record could not be decrypted");
    }
    if (typeof actorToken !== "string" || actorToken.length === 0 || hashPlacementActorToken(actorToken) !== expectedHash) {
      throw new PlacementTokenCustodyError("corrupt", "placement token custody record failed its integrity check");
    }
    return actorToken;
  };

  const remove = async (enrollmentOperationId: string, actorTokenHash: string): Promise<void> => {
    requireCoordinates(enrollmentOperationId, actorTokenHash);
    const record = await readRecord(store, enrollmentOperationId);
    if (record === undefined) return;
    if (!isEncryptedPlacementTokenRecord(record)) {
      throw new PlacementTokenCustodyError("corrupt", "placement token custody record is invalid");
    }
    if (record.actorTokenHash !== actorTokenHash) {
      throw new PlacementTokenCustodyError("conflict", "placement operation already has a different actor token hash");
    }
    try {
      await store.delete(operationKey(enrollmentOperationId));
    } catch {
      throw new PlacementTokenCustodyError("unavailable", "placement token custody store is unavailable");
    }
  };

  return {
    async retain(enrollmentOperationId, actorToken, actorTokenHash) {
      requireCoordinates(enrollmentOperationId, actorTokenHash);
      if (actorToken.length === 0 || hashPlacementActorToken(actorToken) !== actorTokenHash) {
        throw new PlacementTokenCustodyError("conflict", "actor token does not match its declared hash");
      }

      const existing = await readRecord(store, enrollmentOperationId);
      if (existing !== undefined) {
        const retained = await open(existing, actorTokenHash);
        if (retained !== actorToken) {
          throw new PlacementTokenCustodyError("conflict", "placement operation already has a different actor token");
        }
        return;
      }

      let ciphertext: string;
      try {
        ciphertext = await cipher.encrypt(actorToken);
      } catch {
        throw new PlacementTokenCustodyError("unavailable", "placement token encryption failed");
      }
      if (ciphertext.length === 0 || ciphertext === actorToken) {
        throw new PlacementTokenCustodyError("unavailable", "placement token encryption returned invalid ciphertext");
      }

      const record: EncryptedPlacementTokenRecord = { version: 1, actorTokenHash, ciphertext };
      const key = operationKey(enrollmentOperationId);
      try {
        if (await store.create(key, JSON.stringify(record))) return;
      } catch {
        throw new PlacementTokenCustodyError("unavailable", "placement token custody store is unavailable");
      }

      const winner = await readRecord(store, enrollmentOperationId);
      const retained = await open(winner, actorTokenHash);
      if (retained !== actorToken) {
        throw new PlacementTokenCustodyError("conflict", "placement operation already has a different actor token");
      }
    },

    async recover(enrollmentOperationId, actorTokenHash) {
      requireCoordinates(enrollmentOperationId, actorTokenHash);
      const record = await readRecord(store, enrollmentOperationId);
      if (record === undefined) return undefined;
      return open(record, actorTokenHash);
    },

    terminalRefusal: remove,
    retire: remove,
  };
}
