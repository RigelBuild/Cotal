import type { Presence } from "./types.js";
import { isPresenceRow } from "./subjects.js";

export const AUTH_ROSTER_COMMAND = "roster";
export const AUTH_ROSTER_PAGE_LIMIT = 100;
export const AUTH_ROSTER_PAGE_BYTES = 512 * 1024;

export interface AuthRosterInput {
  limit?: number;
  after?: string;
}

export interface AuthRosterOutput {
  rows: Presence[];
  next?: string;
}

export function parseAuthRosterOutput(value: unknown): AuthRosterOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("auth roster reply is not an object");
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.rows)) throw new Error("auth roster reply has no rows array");
  const rows: Presence[] = [];
  for (const item of row.rows) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error("auth roster reply contains an invalid row");
    const candidate = item as Record<string, unknown>;
    const card = candidate.card;
    if (card === null || typeof card !== "object" || Array.isArray(card))
      throw new Error("auth roster reply contains a row without an identity");
    const id = (card as Record<string, unknown>).id;
    if (typeof id !== "string" || !isPresenceRow(item, id))
      throw new Error("auth roster reply contains an invalid presence row");
    rows.push(item);
  }
  if (row.next !== undefined && typeof row.next !== "string")
    throw new Error("auth roster reply has an invalid cursor");
  return { rows, ...(typeof row.next === "string" ? { next: row.next } : {}) };
}

export const AUTH_ROSTER_INPUT_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: AUTH_ROSTER_PAGE_LIMIT },
    after: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const);

const PRESENCE_ROW_SCHEMA = {
  type: "object",
  required: ["card", "status", "ts"],
  properties: {
    card: { type: "object", required: ["id", "name"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string" } } },
    lifecycleUid: { type: "string" },
    status: { enum: ["idle", "waiting", "working", "offline"] },
    ts: { type: "number" },
  },
} as const;

export const AUTH_ROSTER_OUTPUT_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: { type: "array", maxItems: AUTH_ROSTER_PAGE_LIMIT, items: PRESENCE_ROW_SCHEMA },
    next: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const);

/** Freeze nested schema members before exposing the contract to importers. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
